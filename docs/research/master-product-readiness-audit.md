# Emerald Agent Fabric — Master Product Readiness Audit

**Audit date:** 2026-10-26  
**Scope:** Read-only repository audit and one audit document. No production implementation changes were made.  
**Repository state:** `master` at `5dc3b2f`; the worktree already contained modified runtime files and a large set of untracked phase artifacts before this audit.

## Executive decision

**Release classification: experimental research runtime — not production ready.**

The repository contains substantial, testable building blocks for governed execution: typed proposals, tool adapters, SQLite-backed state, leases and recovery, Docker and in-process providers, evidence/replay, an Ollama adapter, a CLI, and extensive deterministic tests. These are meaningful assets.

It has not demonstrated the required user-to-verified-repair workflow. The only directly inspected governed live repair (`EAF-BM-01`, Phase 44D) issued five successful but redundant `read_file` actions, produced no patch, and stopped at `MAX_STEPS`. The current public `emerald run start` and `emerald repair start` paths inject a deterministic mock that runs `git_status` and declares completion; they do not wire the configured Ollama adapter into a real task loop. Current repository-wide type checking also fails, and the full test run did not finish within the audit limit.

## Evidence collected

| Check | Result | Evidence / interpretation |
| --- | --- | --- |
| Repository baseline | **DIRTY** | Three tracked files were modified and numerous documents, scripts, tests, and scratch results were untracked before this audit. They are preserved and are not treated as release-baseline evidence. |
| Source and test inventory | **PRESENT** | 266 TypeScript source files and 175 `*.test.ts` files were present. |
| Production build | **PASS** | `npm run build` completed successfully using `tsconfig.build.json`. This does not type-check the test tree. |
| Full type check | **FAIL** | `npm run typecheck` (`tsc --noEmit`) reported errors in later-phase application code and tests, including `deadlock-detector`, `deadlock-resolver`, goal-preemption code, and Phase 44/91/94/96/97/98/99 tests. |
| Focused task-context/governance tests | **PASS** | 109 tests passed: task-context contract (3), structured-schema parity (27), live-agent brain (58), and agent-step controller (21). |
| Full Vitest suite | **NOT COMPLETED** | `npm test` was first blocked by sandbox config resolution. The approved unrestricted rerun exceeded 120 seconds and ended with `EPIPE` before Vitest produced a final summary. Visible child-process assertion output was from negative benchmark fixtures, so it is not sufficient to call the suite failed or passed. |
| Live local-model repair | **FAIL (recorded evidence)** | `docs/research/phase44-structured-output-and-repair-loop-report.md` and `scratch/phase44d-repair-results.json` record five valid reads of `src/calc.js`, zero writes, zero patch bytes, no verification run, and `MAX_STEPS`. No new live trial was run in this audit. |
| Live trial after Phase 45 task-context change | **NOT TESTED** | The focused contract tests show objective/criteria propagation, but no inspected evidence establishes that the change causes a repair. |

### Commands executed

```text
git status --short
git log -5 --oneline
rg --files
npm test
npm run typecheck
npm run build
npx vitest run tests/contract/task-context-contract.test.ts tests/contract/action-proposal-schema-parity.test.ts tests/application/live-agent-brain.test.ts tests/application/agent-step-controller.test.ts --reporter=dot
git diff --check
```

## Subsystem classification

| Area | Classification | Audit basis |
| --- | --- | --- |
| Domain model, lifecycle, contracts | **Implemented and tested** | Explicit domain types, state machine, mission contracts, capability policies, and targeted tests are present. |
| Typed proposals and validation | **Implemented and tested** | Tool-specific Zod schemas, strict proposal validation, and schema-parity tests are present. Structured output solves known parameter-key failures, not semantic correctness. |
| Context and agent progression | **Partially implemented** | Phase 45 uncommitted changes and focused tests propagate task criteria; no post-change live repair evidence exists. No demonstrated bounded, semantically aware repeated-action control exists. |
| Safe workspace tools | **Implemented with bounded claims** | Read/write/search/git and command adapters plus containment tests are present. Security claims still require release-baseline tests and explicit platform limits. |
| Verification and repair | **Partially implemented** | Repair/verification components and deterministic tests exist, but no inspected live repair reached a candidate patch and verifier pass. |
| Persistence, leases, recovery | **Implemented and tested in focused suites** | Node SQLite adapters, events, transactions, fencing, reopen, and recovery tests are present. Full regression is currently unverified. |
| Docker / execution isolation | **Partially implemented** | Docker and in-process providers exist; local-process operation is weaker than a hostile-code sandbox. Audit did not independently run container/security tests. |
| Evidence, signatures, replay | **Implemented and tested in focused suites** | Evidence/replay/auditor code and research reports are present; integrity evidence must not be conflated with task correctness. |
| Evaluation | **Partially implemented** | Deterministic calibration fixtures and historical reports exist. One inspected live repair failed, and the live model matrix is not current-release evidence. |
| CLI and user workflow | **Partially implemented / misleading default** | Commands exist, but `src/cli/emerald-cli.ts` supplies a hard-coded mock for default run/repair, preventing an ordinary user from demonstrating a local-model repair via the advertised command. |
| Installation and release operations | **Incomplete** | README and release report claim production readiness, but the present typecheck and full-suite baseline do not support that claim. |

## Critical gaps, prioritized

1. **Prove one supported repair end to end.** A grounded task must reach inspection, safe edit, exact verification, truthful terminal status, and evidence. This is the immediate product blocker.
2. **Make the supported execution path real.** The CLI must either wire a configured local model into the governed loop or explicitly present itself as a deterministic demonstration. It must not imply autonomous repair when it only invokes a mock.
3. **Restore a clean regression baseline.** Resolve all full-typecheck failures, then obtain a complete Vitest summary with explicit pass/fail/skip counts. Do not rely on historical counts for the dirty current checkout.
4. **Define and test bounded progression.** Measure repeated actions by task-relevant semantics, preserve legitimate multi-read workflows, and record distinct outcomes for repetition, `MAX_STEPS`, model timeout, rejection exhaustion, and infrastructure failures.
5. **Separate security guarantees by provider.** Document and test Docker versus local-process isolation, including filesystem/network/resource/process-cleanup limits. Path containment alone is not a sandbox.
6. **Rebuild release evidence from the declared baseline.** A release report must name the commit, clean-worktree condition, commands, outcomes, live-test configuration, and known limitations.

## Roadmap and acceptance criteria

| Order | Bounded outcome | Acceptance criteria |
| --- | --- | --- |
| 1 | Repair live task context/progression integration | A single supported fixture preserves objective and acceptance criteria through context construction; the agent performs a justified edit; the expected verifier command passes; evidence binds the exact patch and verification result. |
| 2 | Establish safe bounded repair | Invalid paths, oversized/malformed writes, failed writes, incorrect patches, and regression failures cannot produce success; repair attempts and repeated actions are bounded and classified. |
| 3 | Restore regression baseline | `npm run typecheck`, `npm run build`, and the complete deterministic suite produce final summaries; failures and skips are recorded rather than hidden. |
| 4 | Validate durability and isolation claims | Crash/restart, lease-fencing, cancellation, resource, network, filesystem, and process-cleanup tests pass for each advertised provider; residual risks are documented. |
| 5 | Evaluate multiple task types | Deterministic positive/negative fixtures plus separately authorized local-model trials report model digest, hardware, limits, latency, actions, rejections, patch and verifier success. |
| 6 | Align user documentation and release gate | CLI/API instructions match executable behavior; a release report classifies every declared requirement as PASS, FAIL, NOT_TESTED, NOT_APPLICABLE, or BLOCKED. |

## Risk register

| Risk | Severity | Mitigation / release condition |
| --- | --- | --- |
| Claiming production readiness without a clean build/typecheck/full test baseline | Critical | Downgrade release language now; only restore it after a clean, reproducible gate. |
| Treating evidence integrity as proof of repair correctness | Critical | Require verifier output bound to the exact candidate patch and task criteria. |
| Observation loop remains after Phase 45 context changes | High | Run one separately authorized live task, inspect its trace, and change only the demonstrated failing boundary. |
| CLI mock is mistaken for local autonomous execution | High | Wire a real configured adapter or label the command as demonstration-only, with a test. |
| In-process execution overstated as sandbox isolation | High | Maintain a distinct trusted-input threat model and require Docker/OCI controls for hostile-code claims. |
| Uncommitted, untracked phase material obscures the release baseline | High | Reconcile, review, and commit or remove only with owner authorization; freeze a clean commit before release. |
| Full suite may be slow/noisy due to benchmark child-process output | Medium | Split deterministic unit/contract/integration/release commands and make the final runner emit reliable summaries. |

## Recommended next implementation task

**Authorize one bounded task: complete and observe a single grounded live repair of `EAF-BM-01` after the Phase 45 task-context changes, with no unrelated refactoring.**

Likely files to inspect/change only if the observed trace justifies it:

- `src/production/benchmark/phase43-benchmark-runner.ts`
- `src/application/live-agent-brain.ts`
- `src/application/agent-step-controller.ts`
- `tests/contract/task-context-contract.test.ts`
- `tests/integration/phase44d-repair-live.test.ts`

Success is a verified patch, not simply valid JSON or successful reads. If the run again stalls, preserve the trace and stop for diagnosis rather than adding broad prompt or architecture changes.

## Known limitations of this audit

- It did not alter production code, run a new live model trial, execute Docker, or make Git mutations.
- Existing uncommitted work may contain improvements not represented in the last commit; it remains unverified until a clean baseline and full gate are obtained.
- The full suite needs a longer, controlled release-gate run to produce a final status; this audit reports only the observed timeout, not a guessed test result.
