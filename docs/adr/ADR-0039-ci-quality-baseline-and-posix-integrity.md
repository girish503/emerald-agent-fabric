# ADR-0039: CI Quality Baseline and POSIX Integrity Gate

## 1. Status
- **Status**: APPROVED / IMPLEMENTED (Phase 1 Milestone 1)
- **Date**: 2026-10-31
- **Relates to**: ADR-0001 (master constitution), ADR-0002 (runtime kernel), ADR-0036 (crash recovery & workspace ownership), ADR-0037 (tenant quiescence), `docs/HANDOFF.md` (audit baseline)
- **Decisions Enacted**:
  - `[PHASE0-D1]` ACCEPT: Safety-over-liveness; unverified quiescence fails closed (`HELD`).
  - `[PHASE0-D2]` ACCEPT WITH CAUTION: Retain `--workers-stopped` operator assertion limitation and supervisor lease-renewal risk.
  - `[PHASE0-D3]` ACCEPT: `DockerExecutionProvider` remains an isolated research/test adapter outside production CLI.
  - `[PHASE0-D4]` ACCEPT: Authorize native POSIX CI workflow on Ubuntu runner.
  - `[PHASE0-D5]` ACCEPT: Use structured, pinned TypeScript baseline and explicit test allowlist.
  - `[ADR-0037-D1]` ACCEPT: Docker outside production CLI.
  - `[ADR-0037-D2]` ACCEPT: Retain label-based Docker container discovery (`emerald.run=<runId>`).
  - `[ADR-0037-D3]` DEFER: Container maximum-lifetime timeout wrapper deferred to Milestone 2.
  - `[ADR-0037-D4]` ACCEPT: Retain 10s quiescence bound and fail-closed escalation.
  - `[ADR-0037-D5]` DEFER: Administrative force-release tooling deferred pending separate design/authorization.
  - **CI Strategy**: Option A selected (strictly execute the 5 tracked, clean unit test files).
- **Not a claim**: This ADR does not claim the repository compiles with zero diagnostics, does not claim all tests run in CI, and does not provide exactly-once execution.

---

## 2. Context & Problem
At base commit `98aa41163cb1c41f62580bbb646ca2a35b75a3e3`, the repository lacked automated CI enforcement on native POSIX platforms. Previous handoff notes (`docs/HANDOFF.md`) recorded an anecdotal claim of "575 errors" during compilation. Furthermore, local working trees accumulated untracked test fixtures, uncommitted ADR implementations, and experimental Docker integration tests that require live Docker daemons unavailable in unprivileged environments.

To establish reproducible software-engineering invariants without breaking existing working-tree state or gating progress on full legacy type resolution, a disciplined CI quality gate was required.

---

## 3. Invariants & Guiding Principles

1. **Isolation from Dirty Tree**: The authoritative baseline must never be captured from an uncommitted or dirty working tree. It must derive strictly from an isolated clean snapshot of the approved base commit (`98aa41163cb1c41f62580bbb646ca2a35b75a3e3`).
2. **Diagnostic Signature Invariant**: Diagnostic identity is defined as `file::code::message`. Volatile physical line and column numbers are excluded from the primary identity key to prevent harmless upstream line shifts from invalidating unchanged code.
3. **Fail-Closed Baseline Gate**: Any diagnostic signature $s \in (S_{\text{current}} \setminus S_{\text{baseline}})$ fails CI with exit code 1.
4. **Informational Baseline Resolution**: Any diagnostic signature $s \in (S_{\text{baseline}} \setminus S_{\text{current}})$ is reported informationally. The baseline manifest remains immutable and is never automatically rewritten by the CI runner.
5. **Option A Test Discipline**: Standard POSIX CI executes only tracked, unit-level tests with deterministic execution, strictly excluding Docker daemon requirements or untracked local test artifacts.
6. **Zero Runtime Mutation**: CI gating tooling is strictly isolated in `scripts/ci/` and `.github/workflows/`; zero modifications to `src/` or runtime contracts are permitted in Milestone 1.

---

## 4. Implementation Details

### 4.1 Authorized Five-File Scope
The implementation is strictly bounded to five files:
1. `.github/workflows/posix-integrity.yml`: GitHub Actions POSIX workflow definition.
2. `scripts/ci/generate-tsc-baseline.js`: Tooling to extract clean commit snapshot and generate baseline manifest.
3. `scripts/ci/tsc-baseline-98aa411.json`: Pinned, structured manifest containing 287 approved diagnostics.
4. `scripts/ci/check-tsc-baseline.js`: Gate runner comparing current compilation diagnostics against baseline manifest.
5. `docs/adr/ADR-0039-ci-quality-baseline-and-posix-integrity.md`: Architectural record.

### 4.2 Empirical Baseline Measurement
Running `generate-tsc-baseline.js` against a clean snapshot of `98aa41163cb1c41f62580bbb646ca2a35b75a3e3` extracted via `git archive 98aa411 | tar -x -C <temp>` with Node `v24.20.0` and TypeScript `5.9.3` (resolved from the `^5.7.2` range in `package-lock.json`) captured **287 unique diagnostic signatures** (disproving the historical anecdotal claim of 575 errors).

### 4.3 Gate Verification Logic
The verification script `scripts/ci/check-tsc-baseline.js`:
- Loads `scripts/ci/tsc-baseline-98aa411.json`.
- Runs `tsc -p tsconfig.json --noEmit --pretty false`.
- Parses diagnostics using path normalization and regular expression extraction.
- Computes $S_{\text{new}} = S_{\text{current}} \setminus S_{\text{baseline}}$ and $S_{\text{resolved}} = S_{\text{baseline}} \setminus S_{\text{current}}$.
- Rejects with exit code 1 if $|S_{\text{new}}| > 0$ or if the baseline is missing/malformed.
- Emits structured console summaries detailing diagnostic counts.

### 4.4 Option A CI Workflow Specification
`.github/workflows/posix-integrity.yml` executes on `ubuntu-latest` with:
- Checkout: `actions/checkout@v4`
- Node: `actions/setup-node@v4` (Node 22)
- Dependencies: `npm ci`
- Quality Gate 1: `node scripts/ci/check-tsc-baseline.js`
- Quality Gate 2: `npx vitest run` targeting exclusively:
  - `tests/recovery/recovery-watch-process.test.ts`
  - `tests/recovery/recovery-host.test.ts`
  - `tests/application/worker-lease-renewal.test.ts`
  - `tests/persistence/phase31-recovery-fencing.test.ts`
  - `tests/adapters/node-fs-workspace-owned-disposal.test.ts`

---

## 5. Consequences & Trade-offs

### Positive
- **Deterministic Quality Gating**: No new compiler errors can be introduced unnoticed in future PRs.
- **Fast, Zero-Cost CI**: Standard POSIX runners execute in < 2 minutes without Docker overhead or cloud model costs (preserving the ₹0-cost local policy).
- **Preservation of Working Tree**: Zero disturbances to the 17 tracked modifications or 17 untracked files in the active development workspace.

### Explicit Limitations & Deferred Items
- **Baseline Legacy Burden**: 287 compiler diagnostics remain in the baseline manifest; resolving them will occur systematically in future phases rather than opportunistically.
- **Option A Test Scope**: Untracked tests (`adversarial-workspace-marker.test.ts`, `docker-tenant-quiescence-adapter.test.ts`, etc.) and Docker integration tests are excluded from CI until formalized in subsequent milestones.
- **Remote Execution Distinction**: Implementation and local verification have been completed; remote GitHub Actions execution will occur upon push to a remote repository.
