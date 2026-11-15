Emerald Agent Fabric — Antigravity Build Prompt
Paste this file into Antigravity and ask it to follow it phase by phase
How to use this file: copy it into your Emerald repo root on your laptop as EMERALD-ANTIGRAVITY-BUILD.md, open that folder in Antigravity, attach this file in the Antigravity agent chat, and say: "Read EMERALD-ANTIGRAVITY-BUILD.md and do Phase 0 only. Report back and stop. Do not code yet."
After you approve Phase 0, say "Proceed to Phase 1", then "Proceed to Phase 2", and so on — one phase at a time. Never let it run all phases in one go.

1. Your role
You are a principal AI engineer working INSIDE this existing repository.
You are not starting a new project. You are completing an existing one.
Preserve all existing work. Do not rebuild from scratch. Do not create a second execution engine. Do not redesign the architecture unless a phase explicitly asks for it.
Stack: TypeScript (strict, ES2022, NodeNext), Node.js, SQLite (WAL, BEGIN IMMEDIATE), Zod, Vitest. Hexagonal architecture: domain / ports / application / adapters / transport / CLI.
Host: Windows 11, Node 24, Intel i3-N305, ~8 GB RAM. Local Ollama only.
2. The truth about the current code — do NOT trust the old status doc
An independent repo audit on 13 Nov 2026 (1,834 files, src 294, tests 270, docs 174) found:
Genuinely solid — keep it:
Durable SQLite state machine, worker leases, lease fencing / LEASE_LOST, crash recovery + restart E2E for deterministic ops
Verification wired into WorkerRuntime: DeterministicVerifier + CleanRoomVerifier (src/application/worker-runtime.ts:1408-1440)
Ollama provider (src/adapters/models/ollama-model-provider.ts, local http://127.0.0.1:11434) + agent loop via WorkerHost (src/application/worker-host.ts:294-336)
safeToResume=false in src/recovery/production-recovery-service.ts:79,107-119
Claims in the old status doc that are NOT in this repo — do not claim them as done:
M4.2 Tranche 1: nowhere in src / tests / docs / scratch. No task_dependencies, no task_relations, no TaskRouterService, no multi-parent DAG. tasks table in src/adapters/persistence/schema.ts:14-21 has no dependency columns.
Observability Phase 3: ABSENT, not merely undeployed. Zero hits for ObservabilityPort, EmeraldObservability, Langfuse client, Prometheus, Grafana, OpenTelemetry, OTLP, /metrics, /health. Langfuse doc says design deferred to Phase 18.
GovernedToolConnectorService, ScopedContextMemoryService, BoundedRepairLoopController: do NOT exist at all.
ApprovalControl exists but is in-memory Map only (src/control-plane/approval-control.ts:26, 101 lines). No TTL, contractHash, tenantId, taskId, parametersHash, durable store, or WAITING_APPROVAL.
7-outcome verification taxonomy does NOT exist. Code has only VERIFIED | FAILED (src/domain/verification.ts:100,138).
No frontend, no HTTP server, no SSE, no /api/v1, no auth routes in src. Control plane is CLI / library only.
No ModelRegistry / ModelRouter. No CODER role. Roles in src/domain/multi-agent-plan.ts:22 are ANALYZER | IMPLEMENTER | TEST_ANALYST | DEPENDENCY_ANALYST | REVIEWER | RECONCILER, advisory only, zero authority.
G2/G3/G4 fractions in the old doc are untraceable. Real evidence: 0/5 autonomous SWE-bench completion for qwen2.5-coder:3b (docs/production/production-readiness-audit-v2.1.md:106).
Repo docs contradict each other: docs/release/production-readiness.md claims PRODUCTION READY, 1,947/1,947 tests, tsc 0 errors. docs/HANDOFF.md (commit 40abeec) says 5,825 passed / 26 failed / 25 skipped (5,876 total), tsc --noEmit: 575 errors, npm run build NOT run, Phase 1 BLOCKED. Trust HANDOFF.md until you prove otherwise with a fresh run. README.md says V1.0.0-rc1, package.json says v0.1.0 — reconcile this in Phase 0.
3. Frozen rules — never break these
₹0 cost. Open-weight / open-source models only. Local Ollama inference only. No OpenAI / Anthropic / Gemini APIs. No paid inference services. No paid observability hosting.
No model downloads without explicit user approval.
No live inference change: live tests were never run and need authorisation. Do not run live autonomous coding to prove CODER — use fixture / mock for integration proof, and clearly label it as fixture-backed, NOT genuine local-model coding.
No commits, pushes, merges, or deployments without explicit user approval. You may edit files locally. The user commits and pushes.
Preserve security, recovery, tenant-isolation, and verification safeguards at all times: at-least-once delivery (never exactly-once claims), lease expiry is not proof of process death, never blindly retry uncertain non-idempotent operations, no stale-worker mutations, no recovery-gate bypass, no raw DB mutation through external interfaces, no unrestricted shell / filesystem access, no self-approval, no node:vm as a hostile-code sandbox, no rootless-Docker claims on local Windows WSL2.
Verification is fail-closed: missing / empty verificationSpecs does NOT mean success. Every required spec must have a VERIFIED result. Do not change this to pass tests.
4. Phase 0 — Reconcile + baseline (DO THIS FIRST, then STOP and report)
Run git status, git branch --show-current, git log --oneline -10, git rev-parse HEAD. Record repo URL / remote, branch, HEAD commit, tracked vs untracked changes. This repo is said to be pushed to GitHub with up to 8 merges — verify that against the local tree. If local and GitHub diverge, report the divergence and STOP. Do not code on a stale copy.
List the tree: counts for src/, tests/, docs/, scripts/, scratch/, benchmarks/, and confirm package.json (@emerald/fabric, version, deps only zod).
Run a reproducible baseline: npm install, then full npm test and npx tsc --noEmit, and npm run build if it runs. Record EXACT numbers: passed / failed / skipped, tsc error count, build result. Do not hide, waive, or silently fix failures in this phase — record them as the before-state.
Reconcile docs/release/production-readiness.md vs docs/HANDOFF.md vs README.md vs package.json version. List every contradiction in your Phase 0 report.
Output: a PHASE-0-REPORT.md in the repo root with provenance, baseline numbers, contradictions, and residual risks. Then STOP and wait for the user to say "Proceed to Phase 1".
5. Phase 1 — Shared interfaces first (STOP and report)
Before any parallel work, write down and agree the shared contracts in a PHASE-1-INTERFACES.md:
task_dependencies schema + migration (owner: one file, src/adapters/persistence/schema.ts — single migration owner, no parallel schema edits)
Approval store schema (SQLite, TTL, contractHash, tenantId, taskId, operation, parametersHash, single-use, WAITING_APPROVAL)
Scoped memory schema (scoped_memories table: tenant, scope, role, source/authority, SHA-256 hash, TTL, idempotency)
Connector interface, repair interface, verification spec shape, SSE event shapes, API request/response shapes
Who owns what file, so two agents do not edit the same file at the same time.
Then STOP and wait for approval.
6. Phase 2 — Build all 8 items (in this order, one item at a time, test after each)
Work as two tracks, but in Antigravity do them sequentially unless you use its Agent Manager with separate sub-agents on separate files:
Track A — Durable worker integration
Durable approvals: replace in-memory ApprovalControl with a SQLite-backed store. Wire it into WorkerRuntime, ToolExecutionGateway, and RunCoordinator. Add CLI approve / reject, TTL, self-approval prevention, atomic single-use consumption, lease-fenced transitions. No production caller may use the in-memory fallback.
Governed connectors: build GovernedToolConnectorService (new — it does not exist). Server-side capability authorisation, bounded output, cancellation, timeouts, tenant isolation. Wire it as a real production caller in the durable worker path.
Scoped memory: build ScopedContextMemoryService + scoped_memories SQLite table + migration. Wire it into worker context construction and role-to-role handoff. Enforce Truth Firewall: source + authority on every record, no untrusted input becomes trusted truth, prompt-header spoofing neutralised.
Bounded repair: build BoundedRepairLoopController (new — it does not exist; existing ProductionRepairOrchestrator is wired only into production-runtime-engine.ts, not WorkerRuntime). Wire it into WorkerRuntime + verification lifecycle. Keep it bounded: iteration ceiling, total time budget, action limit, patch-hash stagnation detection, zero self-approval. Reuse the existing repair orchestrator where it fits — do not duplicate it.
Verification: keep DeterministicVerifier + CleanRoomVerifier wired in. Make verificationSpecs a first-class submission contract — the CLI submit path currently creates contracts with verificationSpecs: [] (src/application/durable-submission.ts:123). Fix that path so empty specs fail closed, not silently pass. Do NOT invent the 7-outcome taxonomy unless you implement it fully with tests — if you keep VERIFIED | FAILED, say so explicitly.
Track B — Orchestration + product
Multi-parent DAG: add task_dependencies table + migration from any existing relations, multi-parent joins, cycle / tenant / immutability checks, dependency-aware scheduling in RunCoordinator.claimRun, restart reconstruction. A child must wait for ALL parents.
Minimal API + SSE + UI: add a minimal HTTP API (no new framework unless the repo already uses one — check first), SSE progress stream, and a simple UI: submit a goal, see task status / plan / agents / tool activity, respond to approvals, inspect artifacts, see verification evidence. Include DAG view and approval UX. No fancy dashboard in v1.
Both tracks
Observability instrumentation: build ObservabilityPort, telemetry sanitisation / secret + path redaction, native OTLP HTTP/JSON export, Langfuse port (fail-closed if unconfigured, no network if not configured), Prometheus registry + /metrics, /health, 14 alert rules, 10 Grafana dashboards. Instrument server, router, workers, agents, models, tools, memory, verification, recovery. Do NOT deploy a live Prometheus / Grafana / Langfuse / PostgreSQL / Loki / Tempo stack — instrumentation only, live deployment is deferred.
Green baseline: after every item, run npm test + npx tsc --noEmit for the changed area, then a full run at the end of Phase 2. Fix the 25 baseline failures and tsc errors honestly — fix the code, do not delete tests, do not weaken assertions, do not waive failures. Record before / after numbers.
7. Phase 3 — Prove all 6 E2E scenarios
Prove each scenario with real SQLite persistence and real integration paths, not mocks alone. Use tests/e2e/ — it currently has only 4 files.
Successful execution: submit → worker → tool → verification → durable completion
Approval-required action: sensitive action pauses, waits for human approval, resumes safely
Verification failure + repair: failed evidence triggers bounded repair and independent retest
Multi-agent DAG: multiple agents execute according to ALL dependency edges
Restart + recovery: work survives process restart (SIGKILL test already exists for deterministic ops — extend it to the agent loop) and safely resumes per recovery policy
Tenant isolation: one tenant cannot read or mutate another tenant's tasks, runs, approvals, or artifacts
For each scenario, report: PASS / PARTIAL / FAIL, with the exact test file, whether it used fixture / mock / deterministic ops or a genuine local model, and the evidence (test output, logs, DB state). Clearly label fixture-backed proofs as fixture-backed. Do NOT claim genuine local-model autonomous coding from a fixture test. Do NOT declare production-ready based on mock-only tests or documentation claims.
8. Reporting — after every phase
After every phase, write a short report in the repo root (PHASE-0-REPORT.md, PHASE-1-INTERFACES.md, PHASE-2-REPORT.md, PHASE-3-E2E-REPORT.md) with:
What changed (exact files changed / added / deleted)
Test results (exact pass / fail / skip, tsc errors, before vs after)
What is still unbuilt / failing
Residual risks
Acceptance status: ACCEPTED / PARTIAL / BLOCKED — and why
Then STOP and wait for the user. Do not start the next phase until the user says so.
9. What you must never do
Do not commit, push, merge, or deploy. Do not create a GitHub PR without being asked.
Do not download models, pull Docker images, or spend money.
Do not delete tests to make the suite green.
Do not claim M4.2, observability, DAG, frontend, or CODER as done until the code + tests prove it.
Do not add a second execution engine, a second router, or a second verification gate. Use the existing durable SQLite execution authority.
Do not send secrets, .env values, or credentials anywhere. There are no .env files in the audited copy — keep it that way.
