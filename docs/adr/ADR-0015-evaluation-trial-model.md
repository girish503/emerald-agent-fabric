# ADR-0015: Repeatable Evaluation Trial Model & Comparable Trial Records

## Status
ACCEPTED (Phase 7.2)

## Date
2026-10-13

## Context
In Phase 7.1 (ADR-0014), Emerald Agent Fabric introduced reproducible evaluation harness contracts (`EvaluationTaskDefinition`, deterministic task content hashing, fixture validation, objective criteria, `EvaluationConfigFingerprint`, `EvaluationMetrics`, and `EvaluationRunResult`).

However, while `EvaluationRunResult` represents the low-level execution outcome of a single evaluation run, it does not yet establish a semantic domain unit for repeated, comparable trials across identical experimental conditions:
1. When evaluating an autonomous agent across repeated executions, each trial must be uniquely and deterministically identified without relying on timestamps or mutable runtime state.
2. A single execution run could be conflated with the evaluation trial concept if identity boundaries are not made explicit.
3. Multiple trials run against different task versions, differing configurations, or altered fixtures could be mistakenly compared or aggregated, corrupting experimental rigor.

## Decision
Introduce an immutable domain model, `EvaluationTrial`, as the evaluation-layer record describing a single execution of an evaluation task under an immutable configuration:

```text
EvaluationTaskDefinition
        │
        ├── taskId
        ├── version
        └── taskContentHash
                 │
                 ▼
      EvaluationConfigFingerprint
                 │
                 ▼
          Evaluation Trial
                 │
                 ├── trialOrdinal
                 ├── trialId
                 └── runtimeRunId
                         │
                         ▼
                Evaluation Runner
                         │
                         ▼
                AgentStepController
                         │
                         ▼
                 Governed Runtime
                         │
                         ▼
               Objective Evaluation
```

Key decisions:
1. **Trial Identity is NOT Runtime Run Identity**:
   - The Runtime Run (`runId`) remains the authoritative execution state machine managed by `RunCoordinator`.
   - `EvaluationTrial` is an immutable evaluation-layer record describing: *"This evaluation task/configuration was executed once (ordinal N), producing this objective outcome and metrics."*
   - `EvaluationTrial` references `runtimeRunId`, but never acts as an execution state machine or grants execution authority.
2. **Canonical Deterministic Trial Identity**:
   - Trial identity is computed deterministically via canonical hashing over:
     `{ configFingerprintHash, taskId, taskContentHash, taskVersion, trialOrdinal }`.
   - Timestamps do NOT define semantic trial identity.
3. **Explicit Trial Ordinal Semantics**:
   - `trialOrdinal` is an explicit, bounded positive integer (`1, 2, ... N`) where `1 <= trialOrdinal <= MAX_TRIAL_ORDINAL` (10,000).
   - Ordinals are immutable once started and included in the canonical trial identity.
4. **Pristine Workspace Isolation**:
   - Every trial executes in a freshly provisioned, isolated workspace initialized deterministically from task fixtures. Workspaces are never reused or shared between trials, completely preventing cross-trial contamination.
5. **Rigid Trial Comparability Contract**:
   - Two trials are considered comparable if and only if their `taskId`, `taskVersion`, `taskContentHash`, and `configFingerprint.fingerprintHash` match identically.
   - Trials with different task versions, altered content hashes, or differing model/harness configurations cannot be silently compared or batched.
6. **No Premature Persistence or Statistics**:
   - `EvaluationTrial` remains an in-memory, JSON-serializable domain record. No database tables, repositories, or statistical aggregations (mean, median, variance, confidence intervals) are introduced in this phase.

## Invariants
1. **Task Identity Triad**: `(taskId, taskVersion, taskContentHash)` uniquely specifies the task.
2. **Configuration Identity**: `EvaluationConfigFingerprint` (modelProvider, model, harnessVersion, taskVersion, generationConfig, fingerprintHash).
3. **Trial Identity**: `(taskId, taskVersion, taskContentHash, configFingerprint, trialOrdinal)` defines the canonical trial identity.
4. **Execution Authority**: Governed strictly by `AgentStepController` + `MissionContract` + `PolicyEvaluator` + `WorkspacePort`. The trial abstraction wraps runner execution and never bypasses governance.
5. **Objective Authority**: `trial.outcome` is determined strictly by evaluating objective criteria against physical workspace evidence; agent claims (`isGoalReached`) remain informational only.
6. **Runtime Authority**: Runtime Run state machine (`RunCoordinator`, SQLite lease store) remains the sole authoritative execution lifecycle.
7. **Metric Semantics**: Preserves `0` as observed zero and `undefined` as unmeasured/unavailable metric.

## Non-Goals
This phase explicitly does NOT introduce:
- Statistical analysis (mean, median, variance, confidence intervals, p-values, effect size).
- Benchmark ranking or leaderboards.
- Distributed or multi-worker execution.
- Persistent evaluation database or SQLite evaluation tables.
- Visual dashboards or web UIs.
- Public benchmark ingestion (SWE-bench, Terminal-Bench).
- Experiment scheduling or parallel trial runners.
- Reflex or adaptive routing comparisons.

## Consequences
- Evaluation runs can now be executed repeatedly (`trialOrdinal = 1, 2, ... N`) and captured as immutable, structured records.
- Experimental conditions are verified tamper-evident through canonical hashing.
- Clean separation between evaluation records (`EvaluationTrial`) and execution state machines (`Run`) is preserved.
