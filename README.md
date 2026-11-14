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

## What Emerald Is NOT

> [!IMPORTANT]
> **Emerald is NOT an autonomous coding agent yet.**
> 
> Across 23 real-model empirical benchmark runs using `qwen2.5-coder:1.5b` on a local CPU host, Emerald achieved an honest **0 / 23 (0.0%) pass rate**:
> - **SWE-bench Lite (40s budget)**: 0/10 (10 `EMPTY_PATCH` failures)
> - **SWE-bench Lite (180s budget)**: 0/10 (10 `TIMED_OUT` during model inference / Action 2)
> - **HumanEval (180s budget)**: 0/10 (6 `EMPTY_PATCH`, 4 `TIMED_OUT`)
> - **HumanEval (600s budget)**: 0/3 (3 `EMPTY_PATCH` failures; average 174s/task with 0 timeouts)
>
> While the governance runtime, lease fencing, tool execution, and verification pipelines operated with 100% fidelity (zero false positives, zero crashes), current lightweight open-weight models (1.5B) on CPU hardware read files (`read_file`) but do not synthesize verified code patches.
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
git clone https://github.com/emerald-agent-fabric/emerald.git
cd emerald

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
node bin/emerald.js submit --db ./emerald.sqlite --task "Fix typo in parser tests"

# Execute with specified Ollama model
node bin/emerald.js worker --db ./emerald.sqlite --once --model-provider ollama --model qwen2.5-coder:7b
```

> [!NOTE]
> If a requested model has not been pulled locally, Emerald fails closed immediately with an HTTP 404 error. The runtime will **never** automatically download models or fall back to commercial cloud APIs.

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
