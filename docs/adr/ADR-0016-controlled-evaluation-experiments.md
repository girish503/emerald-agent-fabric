# ADR-0016: Controlled Evaluation Experiment Contracts

## Status
ACCEPTED (Phase 7.3)

## Date
2026-10-13

## Context
Phase 7.1 (ADR-0014) established reproducible evaluation tasks (`EvaluationTaskDefinition`) and Phase 7.2 (ADR-0015) established immutable, repeatable evaluation trial records (`EvaluationTrial`). Together, they provide the domain primitives for executing individual task evaluations under fixed configurations.

However, scientific research and engineering evaluation require controlled comparisons:
1. Comparing multiple conditions (e.g. model variations, prompt policies, tool access profiles, or generation parameters) against the same task.
2. Formulating an explicit, falsifiable research hypothesis prior to execution.
3. Defining the boundary of which trials belong to an experiment, and preventing trials from incompatible tasks or configurations from silently polluting an experimental condition.
4. Preserving the distinction between evaluation metadata and authoritative execution state.

## Decision
Introduce `EvaluationExperiment` and `EvaluationExperimentCondition` as provider-neutral domain contracts defining controlled evaluation comparisons:

```text
EvaluationTaskDefinition
          │
          ▼
EvaluationExperiment
          │
     ┌────┴────┐
     ▼         ▼
Condition A  Condition B
     │         │
     ▼         ▼
 EvaluationTrial records
     │         │
     └────┬────┘
          ▼
     Runtime Runs
```

### 1. Conceptual Hierarchy
- **EvaluationTask**: Specifies what to do, pristine fixtures, objective success criteria, and resource limits.
- **EvaluationExperiment**: Formulates the research hypothesis, binds to a single evaluation task scope, and defines the comparison conditions.
- **EvaluationExperimentCondition**: Represents a controlled configuration condition, binding canonically to an immutable `EvaluationConfigFingerprint`.
- **EvaluationTrial**: One execution of a condition, producing objective verification outcomes and exact execution metrics.
- **Runtime Run**: The authoritative execution state machine with SQLite persistence, lease fencing, and crash recovery.

### 2. Authority Separation
```text
Experiment
   ↓ (Metadata only)

MissionContract
   ↓ (Authority grant)

Policy
   ↓ (Authorization rule)

ToolExecutionGateway
   ↓

Workspace / Sandbox
```
- Experiments and conditions are purely descriptive metadata and have **zero** execution authority.
- An experiment cannot grant capabilities, bypass `MissionContract`, alter policy rules, or issue worker leases.
- All executions proceed through `AgentStepController` and `ToolExecutionGateway`.

### 3. Canonical Experiment Hashing
- `computeEvaluationExperimentHash` computes a deterministic SHA-256 hash over canonical serialized semantic fields:
  `{ conditions, description, experimentId, harnessVersion, hypothesis, plannedTrialCount, taskRef, title, version }`.
- Condition order is canonicalized alphabetically by `conditionId`.
- Ephemeral lifecycle state (`status: DRAFT | READY | RUNNING | COMPLETED | CANCELLED | FAILED`), timestamps, and runtime IDs are excluded from the semantic hash.

### 4. Fenced Trial Membership
- An `EvaluationTrial` can belong to an experiment condition only if it matches the experiment's declared task scope (`taskId`, `taskVersion`, `taskContentHash`) and the condition's exact `configFingerprint.fingerprintHash`.
- Incompatible trials fail closed via `assertTrialCompatibleWithCondition`.
- `plannedTrialCount` defines intended execution scope, not statistical sample size.

## Invariants
1. **Experiment Identity**: Versioned entity `(experimentId, version, experimentContentHash)`. Any semantic definition change requires a version bump.
2. **Single Task Scope**: An experiment binds strictly to one evaluation task specification `taskRef: (taskId, taskVersion, taskContentHash)`.
3. **Condition Configuration Immutability**: Each condition is bound to an immutable `EvaluationConfigFingerprint`.
4. **Hypothesis as Metadata**: Natural language hypothesis text is research documentation and confers zero execution or policy authority.
5. **Objective Verification Supremacy**: The experiment layer cannot override the objective criteria evaluation of the underlying task.
6. **No Conflation with Runtime Run**: The experiment lifecycle is distinct from the authoritative Runtime Run state machine.

## Non-Goals
This phase explicitly does NOT introduce:
- Statistical analysis (mean, median, variance, confidence intervals, p-values, hypothesis testing).
- Sample-size or statistical power calculations.
- Benchmark ranking, scoring, or leaderboards.
- Experiment scheduling, worker queues, or parallel execution engines.
- Persistent experiment tables or evaluation database migrations.
- UI dashboards or visualization tools.
- Public benchmark ingestion (SWE-bench, Terminal-Bench).
- Reflex, adaptive routing, or prompt evolution loops.

## Consequences
- Evaluation studies can now be specified with explicit hypotheses and controlled conditions.
- Experimental conditions are tamper-evident and protected against configuration drift.
- Trial membership is strictly fenced, preventing accidental cross-task or cross-configuration contamination.
