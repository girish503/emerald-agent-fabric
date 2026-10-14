# ADR-0022: Controlled Empirical Baseline-vs-Reflex Evaluation

## Status
Accepted

## Context
Across Phase 7, Emerald Agent Fabric established a rigorous, five-layer scientific evaluation architecture:
```text
EvaluationTask
      ↓
EvaluationExperiment
      ↓
EvaluationCondition (BASELINE | REFLEX)
      ↓
EvaluationTrial (Immutable Runtime State Record)
      ↓
EvaluationReport (Descriptive Comparison)
      ↓
StatisticalAnalysis (Wilson Score, Student's t, Cohen's d)
```

In Phase 8.1 and 8.2, the runtime introduced the governed Reflex interceptor architecture and three deterministic safety heuristics:
1. `reflex.failure-loop.v1` (intervenes on consecutive tool failures on identical input)
2. `reflex.redundant-action.v1` (intervenes on repeated identical read actions on unchanged context)
3. `reflex.budget-pressure.v1` (intervenes when resource consumption approaches budget ceilings)

While Phase 7 established the theoretical experimental machinery and Phase 8.2 established the deterministic rules, the runtime lacked an end-to-end controlled evaluation harness to empirically compare unassisted `BASELINE` and `REFLEX` execution under identical conditions. Specifically:
- No frozen evaluation tasks existed that targeted Reflex intervention boundaries.
- `EvaluationMetrics` lacked typed fields to capture Reflex telemetry (evaluations, allowances, rejections, defers, rule trigger counts).
- `EvaluationExperimentCondition` and `EvaluationTrial` lacked explicit binding of `ruleConfigurationHash`, creating potential identity collisions when comparing conditions sharing identical model fingerprints.
- No integrated orchestrator existed to execute matched trial batches, compile descriptive comparisons, and produce mathematical statistical analyses between conditions.

## Decision

### 1. Four Frozen Evaluation Tasks
Establish four deterministic, hermetic evaluation tasks in `src/application/evaluation/baseline-reflex-tasks.ts`:

1. **`TASK_A_NORMAL_WORK` (`task-baseline-reflex-normal`)**:
   - Sequential productive workflow: reads `input.txt`, transforms content to uppercase, and writes `output.txt`.
   - **Hypothesis**: Both `BASELINE` and `REFLEX` achieve 100% objective success; `REFLEX` produces zero false-positive rejections or defers.

2. **`TASK_B_REPEATED_FAILURE` (`task-baseline-reflex-failure-loop`)**:
   - Loop on failing tool input: agent repeatedly queries a nonexistent file (`missing.txt`).
   - **Hypothesis**: `BASELINE` executes tool calls until step ceiling exhaustion; `REFLEX` detects failure streak via `reflex.failure-loop.v1` and rejects subsequent proposals, bounding wasted tool invocations.

3. **`TASK_C_REDUNDANT_ACTION` (`task-baseline-reflex-redundant-action`)**:
   - Redundant read loop: agent repeatedly executes identical reads without mutating workspace state.
   - **Hypothesis**: `BASELINE` runs until budget exhaustion; `REFLEX` detects redundancy via `reflex.redundant-action.v1` and rejects repeated proposals.

4. **`TASK_D_BUDGET_PRESSURE` (`task-baseline-reflex-budget-pressure`)**:
   - Resource threshold scenario: agent operates near step ceiling.
   - **Hypothesis**: `BASELINE` runs until unmanaged `MAX_STEPS` timeout (`TIMED_OUT`); `REFLEX` detects budget pressure via `reflex.budget-pressure.v1` and safely defers action (`DEFER`), transitioning to `BLOCKED`.

### 2. Reflex Telemetry in Evaluation Domain Models
Extend `EvaluationMetrics` (`src/domain/evaluation.ts`) with typed, optional Reflex telemetry:
- `reflexEvaluations`: Total proposal evaluations by Reflex.
- `reflexAllows`: Count of proposals permitted (`ALLOW`).
- `reflexRejects`: Count of proposals denied (`REJECT`).
- `reflexDefers`: Count of proposals deferred (`DEFER`).
- `failureLoopTriggers`: Invocations of `reflex.failure-loop.v1`.
- `redundantActionTriggers`: Invocations of `reflex.redundant-action.v1`.
- `budgetPressureTriggers`: Invocations of `reflex.budget-pressure.v1`.

Invariants:
- Telemetry fields are strictly `undefined` for `BASELINE` trials (never fabricated).
- When `executionMode === "REFLEX"`, telemetry is extracted directly from the authoritative step transcript.

### 3. Rule Configuration Cryptographic Binding
Bind `ruleConfigurationHash` into:
- `EvaluationExperimentCondition`
- `EvaluationTrial`
- `computeConditionHash`
- `computeEvaluationTrialIdentityHash`

Invariants:
- A condition in `BASELINE` mode has `ruleConfigurationHash: undefined`.
- A condition in `REFLEX` mode carries the SHA-256 hash of its canonical rule configuration.
- Two conditions with identical task and model fingerprints remain distinct in condition hash and trial identity if their execution mode or rule configuration differs.

### 4. Controlled Experiment Orchestration
Implement `executeControlledBaselineReflexExperiment` (`src/application/evaluation/controlled-evaluation.ts`):
- Runs $N$ trials under the `BASELINE` condition.
- Runs $N$ trials under the `REFLEX` condition.
- Generates a verified `EvaluationReport` and `ConditionComparison`.
- Performs rigorous statistical analysis (`analyzeExperiment`):
  - Binary pass rate comparison using Wilson Score intervals.
  - Continuous efficiency metric analysis using Student's t-distribution, mean delta, and Cohen's d effect sizes (steps, actions, tool calls, wall-clock time, proposal rejections).

### 5. Governance & Epistemic Boundaries
- Zero authority expansion: Reflex continues to operate under monotonic authority reduction.
- Zero statistical overclaiming: Reporting distinguishes observed sample statistics from population inferences.
- Objective verification: Trials are scored exclusively by physical success criteria (`FILE_EXISTS`, `FILE_CONTENT_EQUALS`), never by model self-reporting.

## Consequences

### Positive
- Enables repeatable, automated, and mathematically rigorous comparison of agent efficiency and safety.
- Exposes concrete empirical evidence of Reflex bounding wasted tool execution in failure and redundancy scenarios.
- Guarantees cryptographic condition isolation: trials from different rule configurations cannot collide.
- Maintains zero runtime overhead when Reflex is disabled.

### Negative / Limitations
- Four tasks represent specific canonical scenarios; broader benchmark suites (e.g., SWE-bench) require external repository fixture infrastructure.
- Statistical power for small sample sizes ($N < 10$) results in wider confidence intervals; large empirical claims require higher trial counts.

## Non-Goals
- Modifying Reflex heuristic logic or tuning thresholds during this phase.
- Integrating machine learning, neural networks, or prompt-based judgment into Reflex.
- Modifying underlying statistical formulas in `src/domain/statistical-analysis.ts`.
- Running long-running public benchmark campaigns.
