# Changelog

All notable changes to Emerald Agent Fabric will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-26

Emerald adds a deterministic offline trace replay harness, hardened model gateway governance, trace diffing and scorecard evaluation, and a read-only trace workbench in `apps/web`.

### Verification & Live Proofs
- **Offline trace replay**: 20 synthetic fixtures replayed deterministically with zero live model calls across 7 guardrail checks
- **Live Ollama 1.5B proof**: `qwen2.5-coder:1.5b` on `HumanEval/0`, **7 of 7 guardrails passed**, `$0` total spend (`costUsd: 0` recorded on live spans)
- **TypeScript quality gate**: `npm run build` exited `0` (0 diagnostics); `check-tsc-baseline.js` 287 baseline, 255 current, 0 new, 32 resolved

### Added
- **Trace replay harness**: Versioned `emerald-trace-v1` trace format, SQLite WAL trace store, non-invasive trace recorder, 20 synthetic fixtures, and deterministic `TraceReplayRunner` with stub provider.
- **Model gateway hardening**: Explicit model allowlist enforcement, spend cap checks, fail-closed missing-provider errors, and bounded router-level HTTP 429 retry handling.
- **Trace differ & scorecard**: Span-level `diffTraces` / `diffReplayReports`, `scoreTraceSet` / `compareScorecards` with deterministic canonical hashes and persisted reports.
- **Read-only trace workbench (`apps/web`)**: Read-only trace list, span timeline with 7 guardrail outcomes, diff viewer, and scorecard views backed by read-only `GET /api/v1/traces*` routes.

### Fixed
- Recorded explicit `costUsd: 0` for local Ollama inference responses and errors so live Ollama LLM spans pass the `llm_telemetry` guardrail without inventing costs for other providers.

---

## [0.2.0] - 2026-11-16

Emerald is now a working governed agent loop end to end: a live multi-agent mission runs Researcher → Coder → Tester → Reviewer with real human approval, fail-closed verification, bounded repair, and honest benchmarks.

### First verified patches
- Groq `openai/gpt-oss-120b`: **5/5 verified patches on solvable tasks (5/10 overall)**, all first-attempt, $0.04 total spend
- Local `qwen2.5-coder:1.5b`: 0/23 — model capability was the ceiling, not the loop
- Local `qwen2.5-coder:7b`: 0/10 — RAM-starved timeouts on an 8 GB host; Groq is the production inference layer

### Live proofs
- Live multi-agent mission: 4/4 subtasks verified, 7/7 tests, real human approval, $0.0013
- Six live E2E scenarios: **6/6 passed** in 123.1s, $0.0031 (success path, approval-required, verification failure + repair, multi-agent DAG, restart + recovery, tenant isolation)
- Live monitoring: Prometheus + Grafana + Langfuse, with traces flowing end to end
- Frontend execution workspace: live DAG streaming, approve/reject controls, verification proof cards

### Added
- Issue templates (`bug_report.md`, `feature_request.md`) and pull request template (`pull_request_template.md`).
- Operator quickstart guide with local development credentials in `README.md`.
- Actionable authentication configuration diagnostics for `emerald server`.

### Fixed
- Standardized database name to `./emerald.db` across documentation and CLI examples.
- Eliminated all hardcoded developer machine paths across test suites, reports, and benchmark fixtures.
- Untracked ephemeral scratch scripts and hardened `.gitignore` for `.ts` scratch files.

---

## [0.1.0] - 2026-11-15

### Added
- **Governed Agent Runtime**: Hexagonal runtime kernel with step-loop orchestration, lease heartbeats, and path-contained workspace isolation.
- **Sovereign Verification Engine**: Dual-gate clean-room verifier enforcing physical verification without model self-attestation.
- **Operator Governance Dashboard**: Fastify HTTP and SSE transport server with dark-themed, WCAG 2.1 AA accessible web UI (`apps/web`).
- **Durable Persistence**: SQLite persistence layer operating in WAL mode with `BEGIN IMMEDIATE` transactions and lease fencing.
- **Bounded Repair Loop Controller**: Post-verification failure recovery controller with strict non-idempotent mutation guards.
- **Multi-Model Evaluation**: Benchmark pipelines for HumanEval and SWE-bench Lite supporting local Ollama models (`qwen2.5-coder:1.5b`) and OpenAI-compatible routers (`openai/gpt-oss-120b`).
