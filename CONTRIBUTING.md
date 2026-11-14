# Contributing to Emerald Agent Fabric

Thank you for your interest in contributing to Emerald Agent Fabric! This project is an experimental research-grade infrastructure system exploring governed, bounded, observable, and verifiable autonomous software-engineering agents.

---

## 1. Engineering Philosophy

We follow a strict engineering discipline:
$$\text{SPECIFY} \longrightarrow \text{DESIGN} \longrightarrow \text{IMPLEMENT} \longrightarrow \text{VERIFY} \longrightarrow \text{MEASURE} \longrightarrow \text{DOCUMENT}$$

Key principles:
- **Correctness over Complexity**: We prefer small, explicit, verifiable implementations over monolithic, speculative code.
- **Evidence over Claims**: Every capability and change must be backed by verifiable tests and empirical evidence. Subjective "looks good" grading is prohibited.
- **Fail-Closed Security**: Actions must transit typed validation, capabilities, and policy. If authority or verification cannot be established, the system fails closed.
- **No Speculative Architecture**: Do not add unused layers, speculative microservices, or placeholder abstractions. Introduce architecture only when a concrete requirement exists.

---

## 2. Architecture & Technology Policy

Emerald adheres to a clean Hexagonal (Ports & Adapters) architecture:
- **Domain**: Pure TypeScript models, state machines, events, invariants, and policies. Zero external framework dependencies.
- **Ports**: Strongly-typed interfaces for persistence, clock, workspaces, tool gateways, model providers, and verifiers.
- **Application**: Orchestrators, coordinators, step controllers, reflex engines, and evaluation runners.
- **Adapters**: SQLite (WAL mode, `BEGIN IMMEDIATE` transactions), Node.js FS workspaces, Ollama / OpenAI / Anthropic model adapters, container sandboxes.
- **Transport**: Fastify HTTP & Server-Sent Events (SSE) streaming API, CLI entrypoints.

---

## 3. Getting Started

### Prerequisites
- **Node.js**: `v20.x` or later (tested on Node v20/v24).
- **SQLite**: Local SQLite with WAL mode enabled.
- **Python**: `3.10+` (required for running benchmark task verification scripts).
- **Git**: Installed and configured on your system PATH.
- **Ollama (Optional for local inference)**: Local Ollama daemon running at `http://127.0.0.1:11434` with `qwen2.5-coder:1.5b` (or another supported model).

### Setup
```bash
# Clone repository
git clone https://github.com/emerald-agent-fabric/emerald.git
cd emerald

# Install dependencies
npm install

# Compile TypeScript
npm run build

# Run Vitest test suite
npm test
```

---

## 4. Running Benchmarks

Emerald includes reproducible, zero-cost benchmark harnesses for HumanEval and SWE-bench Lite against local models:

```bash
# Run 10-task HumanEval benchmark against local Ollama
npm run benchmark

# Run with custom task limit or timeout (e.g. 3 tasks with 180s timeout)
node bin/run-humaneval.js --limit 3 --timeout 180

# Run with a different Ollama model
node bin/run-humaneval.js --limit 3 --model qwen2.5-coder:7b
```

---

## 5. Development Guidelines

1. **Strict Type Safety**: All TypeScript must compile with strict mode (`tsconfig.build.json`) with zero type errors.
2. **Deterministic Tests**: Logic and state machines must be covered by deterministic unit tests (`vitest`). Never add non-deterministic delays or flaky assertions.
3. **No Credential Leakage**: Never commit secrets, personal paths, private tokens, or local credentials.
4. **Git Hygiene**:
   - Check `git status` before beginning work.
   - Run `npm test` and `npm run build` before submitting PRs.
   - Avoid opportunistic refactoring of unrelated files.

---

## 6. Code of Conduct

Maintain professional, evidence-driven, and respectful collaboration in all issues, pull requests, and discussions.
