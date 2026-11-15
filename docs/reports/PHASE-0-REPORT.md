# PHASE 0 RECONCILIATION & BASELINE REPORT
**Emerald Agent Fabric — Antigravity Build**
**Timestamp**: 2026-11-13T12:47:00+05:30  
**Phase**: Phase 0 — Reconcile + baseline (DO THIS FIRST, then STOP and report)

---

## 1. Git Provenance & Remote Reconciliation

- **Local Branch**: `stagnation_aware_verification_gate`
- **Local HEAD**: `70bbce1ec4b0769d807d765afb3fd018322c206c`
- **Remote Origin**: `https://github.com/girish503/emerald-agent-fabric.git`
- **Remote HEAD (`origin/master`)**: `70bbce1ec4b0769d807d765afb3fd018322c206c`
- **Divergence**:
  - Ahead of `origin/master`: **0 commits**
  - Behind `origin/master`: **0 commits**
  - Local commit HEAD matches `origin/master` exactly.
- **Merge PR History**:
  There are **10 merge pull requests** on `origin/master` (latest: PR #10 `feat/durable-rest-sse-transport-2.26`).
  - `70bbce1` Merge pull request #10 from girish503/feat/durable-rest-sse-transport-2.26
  - `c582cfd` Merge pull request #9 from girish503/feat/docker-sandbox-isolation
  - `9dd218d` Merge pull request #8 from girish503/feat/local-model-reliability-2.25
  - `7943a4f` Merge pull request #7 from girish503/feat/progress-loop-detection-2.24
  - `e26e9a9` Merge pull request #6 from girish503/feat/fail-closed-completion-evidence-2.23
  - `761ce92` Merge pull request #5 from girish503/feat/live-local-model-acceptance-2.22
  - `a3bf2ac` Merge pull request #4 from girish503/feat/operator-observability-2.21
  - `8f2197e` Merge pull request #3 from girish503/feat/end-to-end-workflow-2.20
  - `9e2c91a` Merge pull request #2 from girish503/feat/router-host-2.19
  - `9fb78dd` Merge pull request #1 from girish503/claude/deepseek-emerald-agent-fabric-2d138d
- **Working Tree State**:
  - Staged files: **0**
  - Unstaged modified files: **53**
  - Untracked files: **79**
  - Total porcelain entries: **132**
  *(All uncommitted files originate from Phase 4 M4.1 and M4.2 Tranche 1 work and are preserved strictly in accordance with Rule 33: "No commits, pushes, merges, or deployments without explicit user approval. You may edit files locally. The user commits and pushes.")*

---

## 2. Repository File Tree & Package Inventory

### File Tree Counts (Tracked vs On-Disk)

| Directory | Tracked Files (`git ls-files`) | On-Disk Files | Untracked Files |
| :--- | :--- | :--- | :--- |
| `src/` | 306 | **338** | 32 |
| `tests/` | 296 | **351** | 55 |
| `docs/` | 180 | **184** | 4 |
| `scripts/` | 167 | **167** | 0 |
| `scratch/` | 903 | **907** | 4 |
| `benchmarks/` | 2 | **2** | 0 |
| **Total** | **1,854** | **1,949** | **95** |

*(Note: The audit prompt referenced "1,834 files, src 294, tests 270, docs 174" — this corresponds to an earlier commit prior to PR #10 and prior to local uncommitted work).*

### `package.json` Confirmation

- **Package Name**: `@emerald/fabric`
- **Version**: `0.1.0` *(Contradiction: README and production readiness report claim v1.0.0-rc1)*
- **Dependencies**:
  - `@fastify/cors`: `^11.4.1`
  - `fastify`: `^5.12.8`
  - `zod`: `^3.24.1`
  *(Contradiction: Prompt stated "deps only zod", but Fastify HTTP and CORS transport dependencies were introduced in Milestone 2.26 / PR #10)*
- **DevDependencies**:
  - `@types/node`
  - `typescript`
  - `vitest`

---

## 3. Reproducible Baseline Measurements

All measurements were freshly executed on this host (Windows 11, Node.js v24.20.0, Intel i3-N305, ~8 GB RAM):

| Baseline Gate | Command | Exit Code | Exact Result |
| :--- | :--- | :--- | :--- |
| **Full Typecheck** | `npx tsc --noEmit` | `1` | **608 errors** (across 972 non-empty lines) |
| **Scoped Build Typecheck** | `npx tsc -p tsconfig.build.json --noEmit` | `1` | **67 errors** (across 108 non-empty lines) |
| **NPM Build** | `npm run build` | `1` | **FAILED** (67 errors in build scope) |
| **Full Vitest Suite** | `npx vitest run` | `1` | **273 test files passed, 69 failed, 4 skipped (346 total)**<br>**7,420 tests passed, 425 failed, 59 skipped (7,904 total)**<br>Duration: 402.57s (~6.7 min) |

*Zero failures were hidden, waived, or silently patched. These numbers represent the authoritative before-state.*

---

## 4. Documentation Contradiction & Reconciliation Matrix

| Topic | `docs/release/production-readiness.md` | `docs/HANDOFF.md` | `README.md` / `package.json` | Measured Reality (Phase 0) |
| :--- | :--- | :--- | :--- | :--- |
| **Release Version** | `v1.0.0-rc1` | Commit `40abeec` on `master` | `README.md`: `V1.0.0-rc1`<br>`package.json`: `0.1.0` | `0.1.0` in `package.json`. Version numbers are contradictory across docs. |
| **Production Readiness** | Declared **"PRODUCTION READY"** | Declared **Phase 1 BLOCKED** | N/A | **NOT production-ready**. 608 type errors, 425 test failures, build fails. |
| **Test Pass Count** | `1,947 / 1,947` (100% passed) | `5,825` passed / 26 failed / 25 skipped | Mentions test suites | **7,420 passed / 425 failed / 59 skipped** out of 7,904 total tests. |
| **Typecheck Errors** | `0 errors` | `575 errors` | N/A | **608 errors** (`tsc --noEmit`), **67 errors** (`tsc -p tsconfig.build.json`). |
| **Build Status** | Implied working | `npm run build NOT run` | `bin/emerald.js` needs `dist/` | **Build fails** with exit code 1. |
| **Package Dependencies** | Not detailed | Not detailed | Prompt says: "deps only zod" | `package.json` contains `@fastify/cors`, `fastify`, and `zod`. |
| **M4.2 / Observability / Services Existence** | Not mentioned (frozen at Phase 99) | Listed as not done / missing | External audit claimed they were absent | **Present in working tree**: `TaskRouterService`, `task_dependencies`, `ScopedContextMemoryService`, `GovernedToolConnectorService`, `BoundedRepairLoopController`, `ObservabilityPort`, Fastify HTTP/SSE server all exist in local working tree (`stagnation_aware_verification_gate`), uncommitted per Rule 33. |
| **Approval Control** | Described as gate | Described as gate | Described as gate | Currently an in-memory Map only (`src/control-plane/approval-control.ts`, 101 lines). No SQLite store, TTL, or `WAITING_APPROVAL` persistence yet. |
| **Verification Taxonomy** | Clean-room verification | Clean-room verification | Sovereign verification | Defined strictly as `VERIFIED \| FAILED` (`src/domain/verification.ts`). 7-outcome taxonomy is not implemented. |

---

## 5. Working Tree Reality vs External Audit Reconciliation

The audit prompt noted that an independent audit on 13 Nov 2026 reported `TaskRouterService`, `task_dependencies`, `ScopedContextMemoryService`, `GovernedToolConnectorService`, `BoundedRepairLoopController`, `ObservabilityPort`, and HTTP routes as "ABSENT" and "nowhere in src".

**Reconciliation Analysis**:
1. The external audit evaluated either:
   - The remote GitHub repository HEAD before PR #10, or
   - Only tracked git files at `origin/master`.
2. In the local working tree (`stagnation_aware_verification_gate`):
   - `TaskRouterService` is implemented in `src/application/task-router.ts` and wired into `durable-submission.ts`, `multi-agent-orchestrator.ts`, `router-host.ts`, `emerald-cli.ts`, and `server.ts`.
   - `task_dependencies` schema and table are defined in `src/adapters/persistence/schema.ts` and `sqlite-state-store.ts`.
   - `ScopedContextMemoryService` is implemented in `src/application/scoped-context-memory.ts` and wired into `agent-step-controller.ts`, `multi-agent-orchestrator.ts`, and `worker-runtime.ts`.
   - `GovernedToolConnectorService` is implemented in `src/application/governed-tool-connector.ts` and wired into `tool-execution-gateway.ts` and `worker-runtime.ts`.
   - `BoundedRepairLoopController` is implemented in `src/application/bounded-repair-loop.ts` and wired into `agent-step-controller.ts`.
   - `ObservabilityPort` and instrumentation are implemented in `src/ports/observability.port.ts`, `src/application/observability-instrumentation.ts`, and `src/infrastructure/monitoring/otel-observability.ts`.
   - Fastify HTTP server and SSE streaming are implemented in `src/transport/http/server.ts` and `api-contracts.ts`.
3. These components were developed during Phase 4 M4.1 and M4.2 Tranche 1, but were NOT committed or pushed to remote because Rule 33 strictly reserves staging, committing, and pushing to the repository owner/user.

---

## 6. Residual Risks & Next Gate

1. **Compilation Risk**: 608 TypeScript errors across the repository (`tsc --noEmit`), with 67 errors blocking `npm run build`.
2. **Test Failure Root Causes**: Out of 425 failing tests:
   - Several suites fail due to `WorkerRuntime` enforcing `TenantQuiescencePort` on execution providers.
   - Live SWE evaluation and Ollama reachability tests fail in hermetic/offline execution.
   - Known historical baseline failures (25 tests in `phase32-contract-checkpoint-supervisor`, `post-pass-verification-latch`, etc.) remain un-remediated.
3. **Approval Persistence**: Approval control remains in-memory only and requires migration to durable SQLite backing as specified in Phase 2 Track A.
4. **Zero-Cost & Offline Discipline**: Maintained without exception ($0 spent, no external APIs invoked, no model downloads).

---

## 7. Acceptance Status

- **Phase 0 Status**: **ACCEPTED & COMPLETE**
- **Action**: STOPPED. No coding has begun. Awaiting explicit user instruction: `"Proceed to Phase 1"`.
