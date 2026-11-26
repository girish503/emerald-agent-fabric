# Emerald Agent Fabric

Emerald Agent Fabric is a governed runtime and offline evaluation harness for software engineering agents. It treats model output as untrusted proposals, gates risky actions on human approval, verifies code in a clean room, and records every run as an inspectable trace.

[![CI](https://github.com/girish503/emerald-agent-fabric/actions/workflows/posix-integrity.yml/badge.svg)](https://github.com/girish503/emerald-agent-fabric/actions/workflows/posix-integrity.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js Version](https://img.shields.io/badge/Node.js-20.x%20|%2022.x%20|%2024.x-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Release](https://img.shields.io/badge/Release-v0.3.0-blue.svg)](https://github.com/girish503/emerald-agent-fabric/releases/tag/v0.3.0)

> The model proposes. The runtime governs. The sandbox executes. The verifier decides. The evidence proves.

---

## Table of Contents

- [What It Does (and What It Is Not)](#what-it-does-and-what-it-is-not)
- [Who Uses Emerald, and For What](#who-uses-emerald-and-for-what)
- [Quickstart](#quickstart)
- [Trace Replay Harness (v0.3.0)](#trace-replay-harness-v030)
- [Visual Proof](#visual-proof)
- [Benchmarks and Quality Gate](#benchmarks-and-quality-gate)
- [Architecture](#architecture)
- [Model Configuration](#model-configuration)
- [Reports Index](#reports-index)
- [Security Invariants](#security-invariants)
- [Status and Roadmap](#status-and-roadmap)
- [Contributing and License](#contributing-and-license)

---

## What It Does (and What It Is Not)

### What It Does

1. **Record a run as a trace**: Automatically saves every model call, tool call, approval, verification verdict, repair attempt, cost, and latency into a versioned `emerald-trace-v1` record in SQLite WAL storage.
2. **Replay it offline**: Walks recorded spans in order with a stub model provider that returns recorded model outputs verbatim, making zero live model calls.
3. **Check 7 guardrails**: Evaluates `schema_valid`, `provenance`, `redaction`, `capability`, `approval`, `verification`, and `llm_telemetry` on every trace and writes a hashed replay report.
4. **Diff two traces**: Compares two traces or replay reports span by span, listing changed fields, verdict changes, rule transitions, and cost or latency deltas.
5. **Score a trace set**: Evaluates an entire set of traces or reports without sampling and emits a deterministically hashed scorecard.

### What Emerald Is Not

- **Not a coding chatbot**: Emerald is an infrastructure harness for measuring and constraining agents, not Devin, Cursor, or Copilot.
- **Not a prompt wrapper**: Security limits are enforced in typed tool schemas, capability checks, path containment, and SQLite state transitions, not system prompt text.
- **Not an unbounded auto-coder**: Runs enforce step, action, wall-clock, failure, and repair budgets, and privileged steps block until an authenticated operator decides.
- **Not a model training project**: Emerald evaluates local open-weight and hosted models on public benchmarks; it does not train or fine-tune weights.

---

## Who Uses Emerald, and For What

All execution, storage, verification, and replay in Emerald runs locally under your control rather than as a hosted SaaS service.

### 1. "Did my change make the agent better or worse?"
A prompt or model change goes in, and nobody knows if the agent improved. Record a trace before the change and one after, replay both offline, diff them span by span, and read the full-set scorecard so numbers decide instead of guesswork. For any developer tuning an agent.

### 2. "Prove the agent's code was really tested."
The agent says the task is done, which means nothing on its own here. The runtime executes tests independently in a clean-room workspace, hashes the evidence with SHA-256, and records any human approval alongside the verdict so proof can be checked later. For developers and teams letting agents touch real code.

### 3. "Which model should I pay for?"
Run the same tasks across candidate models and compare cost, latency, and verified passes side by side. In this repository, Groq `openai/gpt-oss-120b` produced 5 verified patches on solvable HumanEval tasks for $0.0408 total, while local `qwen2.5-coder:1.5b` produced 0 from 23 unique tasks for $0. For builders choosing between local and hosted models.

### 4. "The agent must never act alone on risky steps."
Privileged operations such as shell execution or destructive changes pause in `WAITING_APPROVAL` until a human operator acts via CLI, REST, or the web UI. An agent cannot approve its own request, and every decision stays in SQLite. For teams running agents near real repositories who need an audit trail.

### 5. "Show what the agent did, step by step."
One trace captures every span: model calls, tool calls, approvals, verdicts, repairs, cost, and latency. Replay that trace anytime offline without new model calls to inspect failures or verify policy compliance. For reviewers, auditors, and developers debugging a failed run.

Emerald does not make agents smart. It makes their work checkable.

---

## Quickstart

Run Emerald and its web governance dashboard locally in a few commands:

```bash
# 1. Clone and install
git clone https://github.com/girish503/emerald-agent-fabric.git
cd emerald-agent-fabric
npm install

# 2. Build the TypeScript backend and the browser UI bundle
npm run build
node apps/web/build.js
```

Set a local development operator principal (in-memory auth config; do not reuse in production) and start the server:

```bash
# Bash / macOS / Linux:
export EMERALD_API_PRINCIPALS='[{"token":"emerald-dev-operator-token-alpha1","principalId":"dev-operator","tenantId":"tenant-default","role":"operator"}]'
node bin/emerald.js server --db ./emerald.db --host 127.0.0.1 --port 3000 --web-ui-root apps/web
```

```powershell
# Windows PowerShell:
$env:EMERALD_API_PRINCIPALS = '[{"token":"emerald-dev-operator-token-alpha1","principalId":"dev-operator","tenantId":"tenant-default","role":"operator"}]'
node bin/emerald.js server --db ./emerald.db --host 127.0.0.1 --port 3000 --web-ui-root apps/web
```

**What success looks like**:
- Open `http://127.0.0.1:3000/` in your browser.
- You will see the **Emerald Agent Fabric — Governance Dashboard**, summary counters, task submission form, and the **Trace Replay, Diff & Scorecard Workbench** populated with all 20 built-in synthetic fixtures offline.
- Enter `emerald-dev-operator-token-alpha1` in the Auth Gate banner and click **Sign In** to connect live backend task, DAG, and `/api/v1/traces*` routes.

---

## Trace Replay Harness (v0.3.0)

Version `v0.3.0` adds an offline trace harness over durable run history:

- **Trace format (`emerald-trace-v1`)**: Typed, redacted execution trace containing pinned model config, ordered spans (`agent`, `llm`, `tool`, `approval`, `verification`, `repair`), approval records, verification verdicts, and repair attempts (`src/domain/trace.ts`).
- **WAL store & auto-recorder**: `SqliteTraceStore` (`src/adapters/persistence/sqlite-trace-store.ts`) persists traces, indexed spans, replay reports, diffs, and scorecards in SQLite WAL tables. `RunCoordinator.tryRecordTrace` (`src/application/run-coordinator.ts`) records traces automatically from `run_events` whenever a run reaches a terminal or `WAITING_APPROVAL` state.
- **Offline replay & 7 guardrails**: `TraceReplayRunner` (`src/evidence/trace-replay-runner.ts`) replays recorded traces deterministically through `TraceStubModelProvider` (verbatim recorded LLM outputs, zero model calls) and checks 7 rules, producing a SHA-256 hashed `TraceReplayReport`:
  1. `schema_valid` — conforms to `emerald-trace-v1` schema.
  2. `provenance` — tool spans declare `trusted` / `untrusted`; blocks privileged downstream tools after untrusted reads or prompt-injection patterns.
  3. `redaction` — rejects unredacted keys or secret-shaped tokens in spans, approvals, verdicts, or repairs.
  4. `capability` — enforces task capability allowlists on tool spans.
  5. `approval` — flags execution spans that run during unresolved pauses or before approval decision timestamps.
  6. `verification` — blocks `COMPLETED` traces with missing or unresolved failing verdicts.
  7. `llm_telemetry` — requires finite non-negative `latencyMs` and `costUsd` on every LLM span (local Ollama explicitly sets `costUsd: 0`; uninstrumented spans fail rather than guessing costs).
- **Differ & Scorecard**: `diffTraces` / `diffReplayReports` (`src/evidence/trace-differ.ts`) compare two runs span by span with cost and latency deltas; `scoreTraceSet` / `compareScorecards` (`src/evidence/trace-scorecard.ts`) aggregate status, guardrail, verdict, and failure-taxonomy counts across the full trace set without sampling.
- **Read-only workbench**: Mounted in `apps/web` (`apps/web/src/components/trace-replay-viewer.ts`) backed by tenant-scoped read-only `GET /api/v1/traces`, `/api/v1/traces/:traceId`, `/api/v1/traces/diff`, and `/api/v1/traces/scorecard` routes (`src/transport/http/server.ts`).

### How to Record, Replay, Diff, and Score

Emerald has no standalone CLI subcommand yet for `emerald-trace-v1` replay or scoring (`node bin/emerald.js replay <runId>` invokes the legacy `ProductionReplayEngine` over evidence bundles). Use the real paths below:

| Operation | Real Execution / Inspection Path |
|---|---|
| **Record a trace** | Automatic inside `RunCoordinator.tryRecordTrace` on terminal/paused runs, or call `buildTraceFromRunData` / `recordTraceForRun` (`src/evidence/trace-recorder.ts`). Verify with `npx vitest run tests/domain/trace.test.ts`. |
| **Replay & check 7 guardrails** | Open the dashboard workbench (`http://127.0.0.1:3000/`) or `GET /api/v1/traces/:traceId`, call `new TraceReplayRunner({ traceStore }).replay(traceOrId)` (`src/evidence/trace-replay-runner.ts`), or run `npx vitest run tests/evidence/trace-replay-runner.test.ts`. |
| **Diff two traces** | Select Old/New traces in the workbench Diff panel (`#trace-diff-panel`) or `GET /api/v1/traces/diff?oldId=...&newId=...`, call `diffTraces` (`src/evidence/trace-differ.ts`), or run `npx vitest run tests/evidence/trace-differ-scorecard.test.ts`. |
| **Score a trace set** | Inspect `#trace-scorecard-panel` in the workbench or `GET /api/v1/traces/scorecard`, call `scoreTraceSet` (`src/evidence/trace-scorecard.ts`), or run `npx vitest run tests/evidence/trace-differ-scorecard.test.ts` and `tests/frontend/trace-replay-viewer.test.ts`. |

![Trace List and Guardrail Outcomes in Workbench](docs/images/trace-workbench-list.png)
*Figure 1: Read-only Trace List and Trace Detail in `apps/web` — Showing fixture statuses, verdicts, guardrail counts (`7/7`, `6/7`, `5/7`), and `trace-02-ollama-1.5b-success-patch` passing `7/7` guardrail pills (`schema_valid`, `provenance`, `redaction`, `capability`, `approval`, `verification`, `llm_telemetry`), report hash `05ed25a45435c96a`.*

![Full-Set Scorecard in Workbench](docs/images/trace-workbench-scorecard.png)
*Figure 2: Full-Set Scorecard View in `apps/web` — Counting all 20 synthetic fixtures (`18` all passed, `2` with violations, `COMPLETED_WITHOUT_VERDICT: 1`, `$0 / $0` cost, `Scorecard Hash: f03aa2ef7ae581ad`) with explicit latency scope badge `Latency Scope: all-span-total (non-agent execution spans)` (`total=197648 ms`, `mean=9882.4 ms`).*

---

## Visual Proof

### 1. Operator Governance Dashboard

![Emerald Operator Governance Dashboard](docs/images/dashboard.png)
*Figure 3: Operator Governance Dashboard (`apps/web`) — Worker lease status, system health counters, task submission form, and append-only event stream.*

### 2. Live Monitoring and Telemetry Stack

Prometheus scrapes `http://127.0.0.1:3000/metrics` and Grafana visualizes execution metrics (`infra/monitoring`).

![Emerald Grafana Live Mission Governance Dashboard](docs/images/grafana-live-mission-dashboard.png)
*Figure 4: Grafana Mission Governance Dashboard (`00-live-mission-governance.json`) — Displaying **15 total tasks**, **11 completed runs**, **8 verifications passed** (`0` failed), **2 repair attempts / 1 repair cycle**, **2 approved gates** (`0` pending), and **$0.0013 total model spend**.*

### 3. Live Multi-Agent DAG and Human Approval Pause

![Emerald Frontend Workspace Mid-Run DAG](docs/images/frontend-workspace-mid-run.png)
*Figure 5: Live DAG Streaming and Human Approval Gate (`apps/web`) — 4-role mission DAG with `CODER` paused in amber `WAITING_APPROVAL`, locking downstream steps until an authorized operator clicks **Approve Execution** or **Reject & Fail Closed**.*

### 4. Sovereign Verification Proof and Repair Timeline

![Emerald Frontend Workspace Completed Proof Card](docs/images/frontend-workspace-completed-proof.png)
*Figure 6: Sovereign Verification Proof and Repair Timeline (`apps/web`) — All 4 DAG nodes `VERIFIED` green, SHA-256 verification card confirming **7/7 integration tests verified** (`exit code: 0`), and the 10-event tool and repair timeline.*

---

## Benchmarks and Quality Gate

Emerald counts timeouts and empty patches as failures. Full per-task breakdowns live in [BENCHMARK.md](./BENCHMARK.md).

### Model Capability and Live Proof Runs

| Run | Benchmark | Model | Tasks | Budget / Task | Passed | Failed | Timed Out | Pass Rate | Key Finding |
| :---: | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **1** | SWE-bench Lite (Phase 5) | `qwen2.5-coder:1.5b` | 10 | 40s | 0 | 10 | 0 | **0.0%** | `EMPTY_PATCH`: Model exited before authoring file edits |
| **2** | SWE-bench Lite (Phase 5b) | `qwen2.5-coder:1.5b` | 10 | 180s | 0 | 0 | 10 | **0.0%** | `TIMED_OUT`: Model inference latency exceeded task budget |
| **3** | HumanEval (Phase 5b) | `qwen2.5-coder:1.5b` | 10 | 180s | 0 | 6 | 4 | **0.0%** | `EMPTY_PATCH` (6) / `TIMED_OUT` during Turn 2 (4) |
| **4** | HumanEval (Phase 6) | `qwen2.5-coder:1.5b` | 3 | 600s | 0 | 3 | 0 | **0.0%** | `EMPTY_PATCH`: Finished in 156–203s with 0 edits |
| **5** | HumanEval (Pilot) | `openai/gpt-oss-120b` | 10 | 600s | 5 | 5 | 0 | **50.0%** | **5/5 verified patches on solvable tasks**; tasks 5–9 halted by upstream quotas ($0.0408 total) |
| **6** | HumanEval (Local 7B) | `qwen2.5-coder:7b` | 10 | 600s | 0 | 0 | 10 | **0.0%** | `TIMED_OUT`: Host RAM pressure (6 MB free) forced swap thrashing (>120s/step) |
| **7** | Live E2E Acceptance | `openai/gpt-oss-120b` | 6 | 180s | 6 | 0 | 0 | **100.0%** | **6/6 live operational scenarios passed** in 123.1s ($0.0031 total spend) |
| **8** | Live Proof (`v0.3.0`) | `qwen2.5-coder:1.5b` | 1 (`HumanEval/0`) | 300s | 0 | 0 | 1 | **0.0%** | Empty patch (`0 B`), timed out at `300.9s`; auto-recorded trace replayed **7 of 7 guardrails**, **$0** spend |

- **1.5B local CPU (`0/23` unique tasks, `33` total trials)**: Too small for multi-turn `edit_file` synthesis; used for zero-cost hermetic CI and trace harness proof runs.
- **7B local CPU (`0/10`)**: Swap-bound on an 8 GB developer machine.
- **120B via Groq (`5/5` solvable HumanEval tasks, `6/6` live E2E scenarios)**: Proved the runtime loop, clean-room verifier, approval pause, and bounded repair loop work when backed by capable reasoning.

### Live Multi-Agent Mission Demo

| Metric | Empirical Run Result | Notes |
| :--- | :--- | :--- |
| **DAG Topology** | 4-Stage Multi-Agent Graph | `Researcher -> Coder -> Tester -> Reviewer` |
| **Subtasks Verified** | **4 / 4 Subtasks VERIFIED** | `sub-1-researcher`, `sub-2-coder`, `sub-3-tester`, `sub-4-reviewer` |
| **Tests Passed** | **7 / 7 Clean-Room Tests** | Unit + integration tests passed via `DeterministicVerifier` |
| **Human Approval** | **Enforced Fail-Closed** | Paused at Coder in `WAITING_APPROVAL`; authorized by operator via CLI |
| **Zero Self-Approval** | **100% Enforced** | Agent attempt to approve its own privileged run rejected fail-closed |
| **Bounded Repair** | **1 Attempt Resolved** | Assertion failure repaired and re-verified clean |
| **Wall-Clock Duration** | **19.3 seconds** | Active execution: 6.8s; operator approval pause: 12.5s |
| **Total Spend** | **$0.0010 USD** | Reported in [MISSION-DEMO-REPORT.md](./MISSION-DEMO-REPORT.md) |

### Live Six-Scenario E2E Acceptance Suite

All six scenarios ran against the Fastify HTTP server (`http://127.0.0.1:3000`), SQLite WAL store, and Groq inference under a **$2.00 spend cap** ([E2E-LIVE-REPORT.md](./docs/reports/E2E-LIVE-REPORT.md)):

| # | Scenario Name | Status | Duration | Spend (USD) | Primary Verifications |
|---|---|---|---:|---:|---|
| **1** | **Success Path** | **PASSED** | 114.8s | $0.0028 | REST task submission, 4-step governed step loop with Groq 120B, clean-room pytest execution, 100% test pass |
| **2** | **Approval-Required** | **PASSED** | 0.1s | $0.0000 | Sensitive action paused in `WAITING_APPROVAL`; self-approval rejected; operator approved via REST; single-use token consumed |
| **3** | **Verification Failure + Repair** | **PASSED** | 1.0s | $0.0001 | Diagnosed `TEST_ASSERTION_FAILURE`; `BoundedRepairLoopController` recorded non-stagnant patch (hash `46b927a8`); re-verified |
| **4** | **Multi-Agent DAG** | **PASSED** | 1.0s | $0.0002 | 4-stage pipeline (`Researcher -> Coder -> Tester -> Reviewer`) with multi-parent dependency gating and SSE DAG stream |
| **5** | **Restart + Recovery** | **PASSED** | 6.1s | $0.0000 | Simulated store crash mid-run; expired lease fenced; coordinator resumed event stream to `COMPLETED` |
| **6** | **Tenant Isolation** | **PASSED** | 0.1s | $0.0000 | Cross-tenant `tenant-alpha` / `tenant-beta` task and DAG inspections failed closed with HTTP 404 |
| **Total** | **All 6 Scenarios** | **6 / 6 PASSED** | **123.1s** | **$0.0031** | Verified across core, transport, persistence, security, and inference layers |

### Verified Build and TypeScript Quality Gate (`v0.3.0`)

```bash
npm run build                        # tsc -p tsconfig.build.json -> exit 0, 0 diagnostics
node scripts/ci/check-tsc-baseline.js # 287 baseline, 255 current, 0 new, 32 resolved
```

### Benchmark CLI Commands

All four scripts exist under `bin/` and invoke compiled build outputs (`dist/`):

```bash
npm run benchmark:humaneval            # node bin/run-humaneval.js
node bin/run-humaneval.js --limit 3 --timeout 600
npm run benchmark                      # node bin/run-benchmark.js (SWE-bench Lite)
node bin/run-benchmark.js --limit 10 --timeout 180
node bin/run-mission-demo.js --output-dir scratch/mission-demo-live
node bin/run-live-e2e-scenarios.js
```

---

## Architecture

Emerald uses a Hexagonal (Ports & Adapters) layout where domain rules depend on nothing external:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Operator & Web Interfaces                         │
│   ├── CLI (bin/emerald.js -> src/cli/emerald-cli.ts)                        │
│   ├── Dashboard & Trace Workbench (apps/web/src/components/)                │
│   ├── HTTP / SSE Control Plane (src/transport/http/server.ts)               │
│   └── Observability (otel-observability.ts, prometheus-registry.ts,         │
│       langfuse-exporter.ts)                                                 │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Ports
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Control Plane & Governance                           │
│   ├── RunCoordinator & Auto Trace Recording (application/run-coordinator.ts)│
│   ├── TaskRouterService (application/task-router.ts)                        │
│   ├── ApprovalControl (control-plane/approval-control.ts)                   │
│   └── CapabilityFenceEnforcer & Workspace Containment                       │
│       (application/capability-fence-enforcer.ts, domain/workspace-path.ts)  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Runtime Loop, Replay Harness & Gateway                   │
│   ├── WorkerRuntime & AgentStepController                                   │
│   ├── LiveAgentBrain (application/live-agent-brain.ts)                      │
│   ├── ToolExecutionGateway (application/tool-execution-gateway.ts)          │
│   ├── BoundedRepairLoopController & CleanRoomVerifier                       │
│   ├── Replay Harness (evidence/trace-recorder.ts, trace-replay-runner.ts,   │
│   │   trace-differ.ts, trace-scorecard.ts)                                  │
│   └── Hardened Model Gateway (application/governed-model-router.ts,         │
│       adapters/models/gateway-policy.ts — allowlist, spend cap, 429 retry)  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Adapters
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Persistence & Execution Adapters                        │
│   ├── SqliteStateStore & SqliteTraceStore (adapters/persistence/ WAL)       │
│   ├── Model Providers (ollama-model-provider.ts,                            │
│   │   openai-compatible-model-provider.ts)                                  │
│   └── Workspace & Sandbox (node-fs-workspace-adapter.ts,                    │
│       git-artifact-exporter.ts, docker-execution-provider.ts)               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Model Configuration

Every environment variable below is verified in `src/adapters/models/ollama-model-provider.ts`, `src/adapters/models/openai-compatible-model-provider.ts`, and `src/adapters/models/gateway-policy.ts`.

### Hosted OpenAI-Compatible Inference (e.g. Groq)

```powershell
# Windows PowerShell
$env:EMERALD_MODEL_PROVIDER = "groq"
$env:EMERALD_MODEL_NAME = "openai/gpt-oss-120b"
$env:EMERALD_API_KEY = "gsk_..."
$env:EMERALD_SPEND_CAP_USD = "2.00"
```

```bash
# Bash / macOS / Linux
export EMERALD_MODEL_PROVIDER="groq"
export EMERALD_MODEL_NAME="openai/gpt-oss-120b"
export EMERALD_API_KEY="gsk_..."
export EMERALD_SPEND_CAP_USD="2.00"
```

Optional gateway controls:
- `EMERALD_MODEL_BASE_URL` / `OPENAI_BASE_URL`: Override provider base URL.
- `OPENAI_API_KEY`: Fallback key variable if `EMERALD_API_KEY` is unset.
- `EMERALD_ALLOWED_MODELS` (and `OLLAMA_ALLOWED_MODELS` for Ollama): Comma-separated model allowlist enforced fail-closed when set.
- `EMERALD_STRICT_ENV_CONFIG="true"`: Require explicit env configuration and disable default fallback URLs/models in provider constructors.

### Local Open-Weights via Ollama (`http://127.0.0.1:11434`)

```bash
# 1. Pull a local model (Emerald never downloads models automatically)
ollama pull qwen2.5-coder:1.5b

# 2. Submit a governed task and run a single local worker pass
node bin/emerald.js submit --db ./emerald.db --task "Fix typo in parser tests"
node bin/emerald.js worker --db ./emerald.db --once --model-provider ollama --model qwen2.5-coder:1.5b
```

Optional Ollama env vars: `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`), `OLLAMA_MODEL`, `OLLAMA_KEEP_ALIVE` (default `10m`), `OLLAMA_ALLOWED_MODELS`. If a requested model is missing locally, `OllamaModelProvider` fails closed with HTTP 404.

---

## Reports Index

All linked files exist in this repository:

- **[Release v0.3.0](https://github.com/girish503/emerald-agent-fabric/releases/tag/v0.3.0)** & **[CHANGELOG.md](./CHANGELOG.md)**: Release history for `v0.1.0`, `v0.2.0`, and `v0.3.0`.
- **[BENCHMARK.md](./BENCHMARK.md)**: Per-task benchmark tables across 33 local 1.5B trials, 10 local 7B tasks, 10 Groq 120B pilot tasks, and 6 live E2E scenarios.
- **[E2E-LIVE-REPORT.md](./docs/reports/E2E-LIVE-REPORT.md)**: Six canonical live operational scenarios (6/6 passed, 123.1s, $0.0031 spend).
- **[MISSION-DEMO-REPORT.md](./MISSION-DEMO-REPORT.md)**: Live 4-role multi-agent mission report (`Researcher -> Coder -> Tester -> Reviewer`).
- **[MONITORING-REPORT.md](./docs/reports/MONITORING-REPORT.md)**: Prometheus, Grafana, and self-hosted Langfuse stack report.
- **[FRONTEND-WORKSPACE-REPORT.md](./FRONTEND-WORKSPACE-REPORT.md)**: `apps/web` real-time DAG streaming, approvals, and verification proof card report.
- **[PILOT-REPORT.md](./docs/reports/PILOT-REPORT.md)**: Groq `openai/gpt-oss-120b` HumanEval pilot report (5/5 solvable verified, $0.0408 total).
- **[RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md)**: Earlier `v0.2.0` release staging manifest and CI gate checklist.

---

## Security Invariants

1. **Fail-Closed Verification**: Model completion claims carry zero authority until clean-room tests/verifiers pass.
2. **Zero Self-Approval**: Agents and model identities are blocked from approving their own privileged requests.
3. **No Blind Retries**: Non-idempotent mutations pause for supervision and require operator action rather than blind retries; HTTP 429 retries stay bounded at the router layer (`MAX_RATE_LIMIT_RETRIES_CAP = 3`).
4. **Lease-Fenced Transitions**: Workers run under time-bounded leases; expired leases fence stale transitions before mutation.
5. **Strict Path Containment**: Workspace adapters block `..` traversal and escaping symlinks (`src/domain/workspace-path.ts`).
6. **Multi-Tenant Isolation**: Cross-tenant REST and SSE queries fail closed with HTTP 404 (`src/transport/http/server.ts`).

See [SECURITY.md](./SECURITY.md) for the full threat model and disclosure policy.

---

## Status and Roadmap

### Completed in v0.3.0
- [x] Versioned `emerald-trace-v1` trace format, SQLite WAL `SqliteTraceStore`, automatic `RunCoordinator` trace recorder, and 20 synthetic trace fixtures (Phase 1).
- [x] Model gateway hardening: explicit model allowlists, fail-closed spend caps, missing-provider fail-closed checks, and bounded router-level HTTP 429 retries keeping `generate()` single-attempt (Phase 2).
- [x] Deterministic offline `TraceReplayRunner` with `TraceStubModelProvider`, 7 guardrail checks, and hashed reports (Phase 3).
- [x] Span-level trace differ (`diffTraces`, `diffReplayReports`) and full-set scorecard (`scoreTraceSet`, `compareScorecards`) with canonical hashes (Phase 4).
- [x] Read-only trace list, detail, diff, and scorecard workbench in `apps/web` backed by read-only `GET /api/v1/traces*` routes (Phase 5).
- [x] Live local Ollama `costUsd: 0` fix across responses and failed/cancelled calls, verified 7/7 guardrails passing on `HumanEval/0`.
- [x] Self-hosted Langfuse LLM trace exporter wired and verified (`src/infrastructure/monitoring/langfuse-exporter.ts`, [MONITORING-REPORT.md](./docs/reports/MONITORING-REPORT.md)).

### Next
- **Bigger benchmarks**: Run 50+ benchmark tasks with quota-aware scheduling across hosted and local tiers.
- **Diff alignment by kind and order**: Align cross-run trace diffs by span kind and execution order in addition to span ID so different runs compare structure cleanly.
- **Single latency-scope definition**: Unify trace and scorecard latency reporting onto one canonical scope instead of carrying separate span-total and LLM-only modes.
- **Full-scale HumanEval rerun**: Evaluate all 164 HumanEval tasks under production inference quotas.

---

## Contributing and License

See [CONTRIBUTING.md](./CONTRIBUTING.md) for architectural boundaries and check commands:

```bash
npm run build
node scripts/ci/check-tsc-baseline.js
npm test
```

Licensed under the [MIT License](./LICENSE).
