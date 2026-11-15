# Emerald Agent Fabric

**A Governed Agent Runtime & Evaluation Harness for Autonomous Software Engineering**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/Node.js-20.x%20|%2022.x%20|%2024.x-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-Vitest-purple.svg)](https://vitest.dev/)

---

> $$\boxed{\text{The model proposes. The runtime governs. The sandbox executes. The verifier decides. The evidence proves.}}$$

Emerald Agent Fabric is an experimental research-grade infrastructure system for safely executing autonomous software-engineering agents. It treats all model outputs as untrusted proposals, evaluating every action against typed capability lattices, path containment barriers, human-in-the-loop approval gates, and sovereign clean-room verification.

---

## What Emerald Is

- **A Governed Agent Runtime**: Provides strict boundary enforcement, capability fencing, attempt-scoped workspace isolation, lease-fenced execution, and deterministic replay for AI-driven software modifications.
- **An Evaluation Harness**: Provides zero-cost, local-only benchmarking pipelines for public datasets like **HumanEval** and **SWE-bench Lite** against local open-weight models (via Ollama).
- **A Sovereign Verification Engine**: Eliminates model self-attestation. Tasks only complete when independent, deterministic verifiers (test suites, linters, exit codes) succeed and produce cryptographic SHA-256 evidence proofs.
- **A Resilient State Machine**: Built on durable SQLite persistence with WAL mode and `BEGIN IMMEDIATE` transactions, ensuring crash recovery, multi-parent DAG task orchestration, and lease fencing.

---

## Operator Governance Dashboard

The Emerald Web Dashboard (`apps/web`) provides real-time observability, task submission, SSE stream inspection, and cryptographic verification evidence:

![Emerald Operator Governance Dashboard](docs/images/dashboard.png)

---

## 2-Minute Quickstart

Get Emerald running locally with the operator dashboard in 2 minutes:

```bash
# 1. Clone the repository
git clone https://github.com/girish503/emerald-agent-fabric.git
cd emerald-agent-fabric

# 2. Install dependencies
npm install

# 3. Compile TypeScript build
npm run build

# 4. Set local development operator credential
# Bash / macOS / Linux:
export EMERALD_API_PRINCIPALS='[{"token":"emerald-dev-operator-token-alpha1","principalId":"dev-operator","tenantId":"tenant-default","role":"operator"}]'

# Windows PowerShell:
# $env:EMERALD_API_PRINCIPALS = '[{"token":"emerald-dev-operator-token-alpha1","principalId":"dev-operator","tenantId":"tenant-default","role":"operator"}]'

# 5. Start the server with the Web UI dashboard
node bin/emerald.js server --db ./emerald.db --host 127.0.0.1 --port 3000 --web-ui-root apps/web

# 6. Open the dashboard in your browser
# Navigate to: http://127.0.0.1:3000/
# In the Auth Gate banner, enter the bearer token: emerald-dev-operator-token-alpha1
```

---

## Empirical Benchmark Status

> [!IMPORTANT]
> **Empirical Evaluation: Lightweight Local CPU vs. Capable Reasoning Models**
> 
> 1. **Local CPU Baseline (`qwen2.5-coder:1.5b`)**:
>    Across 23 real-model empirical runs on a local CPU host, `qwen2.5-coder:1.5b` achieved **0 / 23 (0.0%)**:
>    - **SWE-bench Lite (40s budget)**: 0/10 (10 `EMPTY_PATCH` failures)
>    - **SWE-bench Lite (180s budget)**: 0/10 (10 `TIMED_OUT` during model inference / Action 2)
>    - **HumanEval (180s budget)**: 0/10 (6 `EMPTY_PATCH`, 4 `TIMED_OUT`)
>    - **HumanEval (600s budget)**: 0/3 (3 `EMPTY_PATCH` failures; average 174s/task with 0 timeouts)
>    *Analysis*: Lightweight 1.5B models on CPU execute reads (`read_file`) but lack parameter capacity to plan structured multi-turn edits (`edit_file`).
>
> 2. **Governed External Model Pilot (`openai/gpt-oss-120b` via Groq)**:
>    Under identical runtime governance (`GovernedModelRouterService`, clean-room dual-gate verification, `BoundedRepairLoopController`), `openai/gpt-oss-120b` achieved:
>    - **5 / 5 (100.0%) verified patches on solvable tasks** (`HumanEval/0`, `1`, `2`, `3`, `4`) before reaching upstream daily token quotas (Tasks 5–9 halted by upstream provider tier limits).
>    - **50.0% pass rate overall (5/10)**, with real multi-turn tool interaction (`read_file`, `edit_file`, `run_command`), producing 256 B – 664 B patches passing sovereign physical verification.
>    - Total benchmark spend was **$0.0408 USD** ($0.04 / $2.00 spend cap).
>    *Analysis*: The loop-vs-model question is resolved: the runtime governance and verification loop is sound; model capability was the ceiling.
>
> Detailed methodology, full empirical logs, and durable traces are documented in [BENCHMARK.md](./BENCHMARK.md) and [PILOT-REPORT.md](./docs/reports/PILOT-REPORT.md).
>
> Emerald is **NOT**:
> - A commercial coding assistant (Devin, Cursor, Copilot, OpenHands)
> - A ChatGPT prompt wrapper or conversational chatbot
> - A model training or fine-tuning framework
> - A cloud service requiring paid API tokens

---

## Architectural Layers

Emerald is built using Hexagonal (Ports & Adapters) architecture:

```
                  ┌─────────────────────────────────────┐
                  │    Developer CLI / Fastify HTTP     │
                  └──────────────────┬──────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Control Plane & Governance                      │
│   ├── RunCoordinator: Lifecycle State Machine (LEASED, RUNNING, etc.)  │
│   ├── ApprovalControl: Durable SQLite Human-in-the-Loop Approvals      │
│   ├── CapabilityGuard: C1-C20 Invariants & Workspace Path Containment   │
│   └── TenantQuiescencePort: Physical Process & Container Fencing       │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                           Agent Runtime Core                           │
│   ├── WorkerRuntime: Step-loop orchestration & lease heartbeat         │
│   ├── LiveAgentBrain: Untrusted prompt synthesis & proposal parsing    │
│   ├── ToolExecutionGateway: Scoped tool dispatch (read, write, edit)   │
│   └── BoundedRepairLoopController: Post-verification recovery loop    │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Sovereign Verification                          │
│   ├── DeterministicVerifier: Clean-room test runner & exit code check  │
│   └── Sealed Evidence Store: Tamper-evident SHA-256 evidence bundles   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

- **Node.js**: `v20.0.0` or higher (tested on Node 20, 22, and 24).
- **Git**: `2.30.0` or higher.
- **Python**: `3.10+` (required for running benchmark task verification scripts).
- **Ollama**: (Required for local model execution) running locally at `http://127.0.0.1:11434`.

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/girish503/emerald-agent-fabric.git
cd emerald-agent-fabric

# 2. Install dependencies
npm install

# 3. Compile TypeScript build
npm run build

# 4. Run tests
npm test
```

---

## Running Benchmarks

Emerald includes reproducible, zero-cost benchmark runners that evaluate real models against open datasets under strict governance.

### 1. Run HumanEval Benchmark
Evaluates single-function coding tasks from OpenAI HumanEval:

```bash
# Run the 10-task HumanEval benchmark (180s timeout per task)
npm run benchmark:humaneval

# Run a 3-task subset with custom timeout (e.g. 600s)
node bin/run-humaneval.js --limit 3 --timeout 600
```

### 2. Run SWE-bench Lite Benchmark
Evaluates multi-file repository maintenance tasks from Princeton SWE-bench Lite:

```bash
# Run default 10-task SWE-bench Lite benchmark
npm run benchmark

# Run with custom task limit and per-task timeout
node bin/run-benchmark.js --limit 10 --timeout 180
```

Detailed methodology, recorded results, and full empirical logs across all 23 trials are documented in [BENCHMARK.md](./BENCHMARK.md).

---

## Plugging in a Different Ollama Model

By default, Emerald benchmarks and worker CLI use `qwen2.5-coder:1.5b`. You can plug in any open-weight model supported by Ollama without writing code.

### Step 1: Pull the model in Ollama
```bash
ollama pull qwen2.5-coder:7b
# or
ollama pull deepseek-r1:8b
# or
ollama pull llama3.2:3b
```

### Step 2: Pass the model to the benchmark runner
```bash
# Run HumanEval with Qwen 2.5 Coder 7B
node bin/run-humaneval.js --model qwen2.5-coder:7b --limit 3 --timeout 300

# Run SWE-bench Lite with DeepSeek R1 8B
node bin/run-benchmark.js --model deepseek-r1:8b --limit 5 --timeout 300
```

### Step 3: Use with the Developer CLI
```bash
# Submit a governed task
node bin/emerald.js submit --db ./emerald.db --task "Fix typo in parser tests"

# Execute with specified Ollama model
node bin/emerald.js worker --db ./emerald.db --once --model-provider ollama --model qwen2.5-coder:7b
```

> [!NOTE]
> If a requested model has not been pulled locally, Emerald fails closed immediately with an HTTP 404 error. The runtime will **never** automatically download models or fall back to commercial cloud APIs.

---

## Research & Engineering Reports

All milestone architecture reports, empirical evaluations, and security audits are archived in [docs/reports/](./docs/reports/):

- [PILOT-REPORT.md](./docs/reports/PILOT-REPORT.md): Governed external model pilot on HumanEval (`openai/gpt-oss-120b`, 5/5 verified patches on solvable tasks, $0.0408 total spend).
- [PHASE-7B-REPORT.md](./docs/reports/PHASE-7B-REPORT.md): Bounded repair loop controller and fail-closed verification gate audit.
- [PHASE-7-REPORT.md](./docs/reports/PHASE-7-REPORT.md): Local open-weight baseline evaluation (`qwen2.5-coder:1.5b`) across SWE-bench Lite and HumanEval.
- [UI-WIRE-REPORT.md](./docs/reports/UI-WIRE-REPORT.md): Fastify HTTP, SSE streaming, and operator dashboard integration.
- [VERIFY-BYPASS-FIX.md](./docs/reports/VERIFY-BYPASS-FIX.md): Fail-closed dual-gate sovereign verification enforcement.

---

## Security Invariants

1. **Fail-Closed Verification Gates**: The runtime ignores completion claims unless clean-room verifiers pass.
2. **No Blind Retries**: Destructive and non-idempotent operations are never retried without explicit supervisor rollback and operator approval.
3. **Lease-Fenced Transitions**: Workers execute under bounded leases; expired leases invalidate pending mutations immediately.
4. **Path Containment**: Workspace adapters prevent path traversal attacks (`..` or symlinks).

See [SECURITY.md](./SECURITY.md) for the complete security policy and threat model.

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for architectural guidelines, test requirements, and development standards.

---

## License

This project is licensed under the [MIT License](./LICENSE).
