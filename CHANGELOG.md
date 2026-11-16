# Changelog

All notable changes to Emerald Agent Fabric will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
