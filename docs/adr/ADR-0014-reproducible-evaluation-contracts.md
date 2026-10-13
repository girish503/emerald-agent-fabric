# ADR-0014: Reproducible Evaluation Harness Contracts & Architecture

## Status
Approved (Architecture Specification Baseline)

## Date
2026-10-13

## Governing Documents
- [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- [ADR-0001: Master Engineering Constitution](./ADR-0001-master-engineering-constitution.md)
- [ADR-0002: Runtime Kernel, Durable State Machine, Leased Worker Coordination, and Append-Only Event Store](./ADR-0002-runtime-kernel-and-durable-state-machine.md)
- [ADR-0003: Workspace Sandbox Boundary and Typed Tool System Architecture](./ADR-0003-workspace-and-typed-tools.md)
- [ADR-0004: Tool Execution Gateway, Adapter Boundary, and Multi-Step Action Lifecycle](./ADR-0004-tool-execution-gateway-and-adapter-boundary.md)
- [ADR-0005: Action and Attempt Domain Architecture, Lifecycle Semantics, and Lease-Fenced Persistence](./ADR-0005-action-and-attempt-domain-architecture.md)
- [ADR-0006: Crash Recovery, UNKNOWN Reconciliation, Retry Safety, and Attempt Sweeper](./ADR-0006-crash-recovery-unknown-reconciliation-retry-safety.md)
- [ADR-0007: Typed Context Engine — Observation Selection, Context Budgeting, and Token Governance](./ADR-0007-context-engine-budgeting-and-observation-selection.md)
- [ADR-0008: Agent Brain Interface & Governed Action Proposal Boundary](./ADR-0008-agent-brain-action-proposal-boundary.md)
- [ADR-0009: Governed Autonomous Agent Reasoning Loop & Step Controller](./ADR-0009-governed-autonomous-step-controller.md)
- [ADR-0010: Model Provider Boundary & Provider-Neutral Inference Port](./ADR-0010-model-provider-boundary.md)
- [ADR-0011: LiveAgentBrain Boundary, Context Translation, and Untrusted Action Proposal Pipeline](./ADR-0011-live-agent-brain-boundary.md)
- [ADR-0012: Local Open-Source Model Provider Adapter (Ollama) & Zero-Cost Architecture](./ADR-0012-first-model-provider-adapter.md)
- [ADR-0013: Live Local Agent Governance Validation & Evaluation Smoke Path](./ADR-0013-live-local-agent-validation.md)
- [Runtime Architecture](../architecture/runtime.md)

---

## 1. Context & Problem Statement

Phase 6 established the provider-neutral inference layer (`ModelProviderPort`), `LiveAgentBrain`, `OllamaModelProvider`, and verified live governed execution against local open-source models (Phase 6.4).

With the runtime pipeline verified end-to-end, the next engineering imperative is **evaluation architecture**.
The core research question is:
> **Can Emerald execute the same evaluation task under controlled, reproducible conditions and produce structured evidence that can be compared across models, harness configurations, and runs?**

Prior to Phase 7.1, evaluation was implemented as a single ad-hoc smoke runner (`LocalEvaluationHarness`).
To support rigorous, repeatable scientific evaluation across diverse tasks and configurations without ad-hoc scripts or vendor-locked benchmark harnesses, Emerald requires typed, provider-independent **Evaluation Domain Contracts**.

This ADR establishes the foundational architecture for reproducible evaluation tasks, fixtures, missions, objective success criteria, configuration fingerprints, metric accounting, and evaluation run results.

---

## 2. Decision & Architecture

We introduce a dedicated domain layer for evaluation (`src/domain/evaluation.ts`) and an application evaluation runner (`src/application/evaluation/evaluation-runner.ts`):

```text
EvaluationTaskDefinition (Immutable Domain Spec)
        ↓
EvaluationRunner (Application Coordinator)
        ↓
AgentStepController (Governed Reasoning Loop)
        ↓
Normal Emerald Governance (MissionContract, Policy, Gateway, Sandbox)
        ↓
Runtime Run (Authoritative SQLite State)
        ↓
EvaluationRunResult (Structured Scientific Evidence)
```

### 2.1 Task Identity & Immutability
- **Stable Identity**: Tasks are uniquely identified by a stable slug (`taskId`) and a strictly positive integer revision (`version >= 1`).
- **No In-Place Mutation**: Modifying the semantic definition of a task (fixture, criteria, budget, mission) requires incrementing `version`. An existing version's meaning never silently mutates.
- **Content Hash**: Every task has a canonical SHA-256 content hash (`taskContentHash`) computed over its deterministic specifications, completely excluding runtime timestamps, worker IDs, or model outputs.
- Identity triad:
  $$\text{Task Identity} = (\text{taskId}, \text{version}, \text{taskContentHash})$$

### 2.2 Controlled Fixtures (Input $\ne$ Authority)
- `EvaluationFixture` describes only input files and workspace setup (`initialFiles`).
- **Firewall Invariant**: Fixtures cannot contain credentials (`api_key`, `secret`, `password`), host filesystem paths, Windows drive paths, UNC paths, traversal (`..`), Docker socket paths, or authority-bearing keywords (`workerId`, `leaseId`, `contractId`, `capability`).
- **Bounded Size**: Bounded by maximum file count (100), maximum single file size (1 MB), and maximum fixture payload (10 MB). Exceeding these limits fails closed.

### 2.3 Evaluation Mission & Governance Supremacy
- `EvaluationMission` declares `requiredCapabilities` (e.g. `workspace.file.read`, `workspace.file.write`) and resource limits.
- **The Evaluation Harness Does NOT Grant Authority**:
  The evaluation runner constructs and activates an authoritative `MissionContract` in SQLite using Emerald's existing governance system. The evaluation harness sits strictly **ABOVE** the runtime kernel, never beside or inside it.
- Zero backdoors: Evaluation tasks cannot bypass `MissionContract`, `ProposalValidator`, or `ToolExecutionGateway`.

### 2.4 Objective Success Criteria (Truth vs Agent Claims)
Evaluation success is decoupled from model claims:
- **Agent Self-Claims Are NOT Ground Truth**: If an agent outputs `isGoalReached: true`, this records `agentClaimedGoal = true`, but does NOT produce `status = "PASSED"`.
- **Objective Ground Truth**: Criteria are evaluated strictly against the physical workspace by an independent `CriteriaReader`:
  - `FILE_CONTENT_EQUALS`: Verifies file content matches expected string.
  - `FILE_EXISTS` / `FILE_ABSENT`: Verifies file presence or absence.
  - `TEXT_CONTAINS`: Verifies substring presence.
  - `COMMAND_EXIT_CODE`: Verifies discrete command execution exit code.
  - `VERIFICATION_SPEC`: Evaluates domain `VerificationSpec` against causal evidence.
- An evaluation passes (`status = "PASSED"`) if and only if:
  $$\text{All Objective Criteria Pass} \land \text{Run Terminated Without Error}$$

### 2.5 Evaluation Outcome Taxonomy
We define an explicit 6-state outcome taxonomy (`EvaluationStatus`):
1. `PASSED`: Objective criteria verified successfully and execution completed without error.
2. `FAILED`: Objective criteria failed against the physical workspace.
3. `ERROR`: Model provider or infrastructure failure (e.g. `BRAIN_FAILURE`, endpoint crash).
4. `TIMED_OUT`: Step, action, or wall-clock budget ceiling exhausted (`MAX_STEPS`, `MAX_ACTIONS`, `MAX_WALL_CLOCK`).
5. `CANCELLED`: Execution cancelled cooperatively via `AbortSignal`.
6. `BLOCKED`: Operation blocked by governance fencing (`CONTRACT_REVOKED`, `LEASE_LOST`, `MAX_PROPOSAL_REJECTIONS`, `UNKNOWN_EXECUTION`).

This guarantees clear separation between test assertion failure (`FAILED`), environment crash (`ERROR`), budget exhaustion (`TIMED_OUT`), and governance refusal (`BLOCKED`).

### 2.6 Strict Metric Semantics
`EvaluationMetrics` provides exact, unambiguous measurements:
- `steps`: Total reasoning steps.
- `actions`: Logical `Action` aggregates created.
- `attempts`: Physical `Attempt` executions.
- `modelCalls`: Physical calls to `ModelProviderPort.generate()`.
- `toolCalls`: Physical tool executions dispatched.
- `proposalRejections`: Proposals rejected by `ProposalValidator`.
- `executionFailures`: Actions terminating in `FAILED`.
- `modelFailures`: Invocations throwing model errors.
- `wallClockMs`: Total elapsed run duration.
- `modelLatencyMs` & `toolLatencyMs`: Disaggregated wall-clock durations.
- `inputTokens`, `outputTokens`, `totalTokens`: Extracted strictly from provider usage metadata when reported.
- **Undefined vs Zero Invariant**: If token counts or latencies are not reported by the model provider, they remain `undefined`. They are **never coerced to 0**. A recorded `0` represents observed zero; `undefined` represents unsupported/unavailable.

### 2.7 Configuration Fingerprint
Every result embeds a deterministic `EvaluationConfigFingerprint`:
- `modelProvider`, `model`, `harnessVersion`, `taskVersion`, and sanitized `generationConfig`.
- Computed via canonical SHA-256 hash (`fingerprintHash`).
- Secrets and credentials are automatically redacted before hashing.

### 2.8 Decoupled Trial & Run Identity
- `EvaluationRun`: Represents a specific evaluation trial. Identified by `evaluationRunId`.
- `Runtime Run`: The authoritative SQLite operational state machine. Identified by `runId`.
- The evaluation harness maps:
  $$\text{EvaluationTask} \times \text{ConfigFingerprint} \times \text{TrialNumber} \longrightarrow \text{Runtime Run} \longrightarrow \text{EvaluationRunResult}$$
- Multiple trials can evaluate the same task version without mutating task definitions or runtime kernel state.

### 2.9 Reproducibility Distinction
We explicitly distinguish:
- **Reproducible Experimental Environment**: Same fixture, same task content hash, same contract, same workspace isolation, and same harness version (`harness-0.1`).
- **Non-Deterministic Model Output**: Generative model sampling may vary across runs.
Emerald guarantees reproducibility of the **experimental conditions**, not stochastic model determinism.

---

## 3. Security Invariants Confirmed

1. **No Direct Tool Invocation**: `EvaluationTaskDefinition` and `EvaluationRunner` contain zero tool execution handles. They cannot invoke `ToolAdapter` directly.
2. **No Policy Bypass**: Capabilities requested in `EvaluationMission` must be authorized by `createExecutionPolicy` and bound to an active `MissionContract`.
3. **Workspace Path Containment**: Fixture paths and criterion paths are validated lexically via `sanitizeWorkspacePath` and verified via realpath canonicalization.
4. **Credential Immunity**: Sensitive keys (`api_key`, `secret`, `password`) are rejected in fixtures and redacted in configuration fingerprints.
5. **No Parallel State Stores**: The evaluation runner references authoritative runtime `runId` and causal event IDs; it does not duplicate event persistence.

---

## 4. Why This Is Not Yet a Benchmark

Phase 7.1 establishes **evaluation infrastructure contracts**, NOT a benchmark:
- No benchmark datasets (e.g. SWE-bench, Terminal-Bench) are imported.
- No leaderboards or competitive scores are reported.
- No statistical aggregation across large problem sets is performed.
- Future phases (Phase 7.2+) will build dataset loaders and task suite runners on top of these immutable contracts.
