# ADR-0017: Descriptive Evaluation Reporting & Baseline Comparison

## Status
Accepted

## Context
Phase 7.1 established immutable, versioned evaluation tasks (`EvaluationTaskDefinition`) with objective ground-truth criteria.
Phase 7.2 established immutable, repeatable evaluation trial records (`EvaluationTrial`).
Phase 7.3 established controlled evaluation experiment contracts (`EvaluationExperiment`) that group comparable experimental conditions across an explicit evaluation hypothesis and task scope.

While conditions and trials can be defined and executed within Emerald's governed runtime, there was previously no domain or application artifact for consolidating completed trial records into a deterministic, descriptive report. Without an explicit reporting model, analysis risked becoming ad-hoc, prone to silent distortion (such as treating missing metrics as zero, or collapsing incomplete trials into failures), and prone to premature statistical overclaiming.

## Decision
Introduce a pure evaluation reporting layer that derives deterministic descriptive reports (`EvaluationReport`) and explicit condition comparisons (`ConditionComparison`) from immutable evaluation records.

### Key Principles

1. **Evidence Description != Statistical Proof**:
   ```text
   EvaluationReport
       = description of observed evidence

   NOT

   EvaluationReport
       = statistical proof
   ```
   A report answers descriptive empirical questions:
   - "How many completed trials passed the objective criteria?"
   - "What were the observed counts, latencies, and token usages across conditions?"
   It explicitly does NOT make statistical or causal claims (no p-values, no confidence intervals, no claims of significance or causation).

2. **Zero Execution Authority**:
   Reporting is a pure read/derive function over completed records:
   - Zero process execution, zero Docker invocations, zero network calls.
   - Zero mutation of Runtime Runs, EvaluationTrials, or EvaluationExperiments.
   - Zero capability or lease issuance.
   - Zero permission grants.

3. **Deterministic Report Identity**:
   Reports are identified strictly by the experiment they describe:
   `experimentId`, `experimentVersion`, `experimentContentHash`.
   `reportContentHash` is computed canonically over sorted semantic contents and excludes runtime timestamps, worker IDs, lease IDs, or ephemeral state.

4. **Explicit Outcome Bucketing & Preserved Denominator**:
   All evaluation outcomes (`PASSED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `BLOCKED`, `ERROR`) are preserved in a discrete distribution.
   Objective pass rates are represented as strongly typed descriptive ratios `{ numerator, denominator, rate }`.
   Incomplete executions (`TIMED_OUT`, `CANCELLED`, `BLOCKED`, `ERROR`) are excluded from the completion denominator; if no evaluations completed, the pass rate is explicitly `undefined` rather than fabricated `0`. When zero passes occur among completed trials, the rate is exact `0`.

5. **Missing Metric Preservation**:
   Existing metric semantics (`0` = observed zero, `undefined` = unavailable/unsupported) are strictly preserved.
   Averages participate only with observed values, and aggregates expose `observedCount` and `unavailableCount`.
   Aggregates with zero observed values remain `undefined`.

6. **Explicit Baseline Comparison**:
   Comparisons require an explicit baseline designation (no implicit `condition[0]` inference).
   Deltas are reported descriptively (`deltaAverage`, `deltaSum`, `delta`) rather than labeled as "improvements".
   Comparisons fail closed if conditions do not match task scope (`taskId`, `taskVersion`, `taskContentHash`).

## Explicit Non-Goals
- Statistical inference (variance, standard deviation, confidence intervals, p-values, hypothesis tests).
- Statistical significance testing or power analysis.
- Causal claims or superiority assertions.
- Benchmark ranking or competitive leaderboards.
- Persistent reporting databases (SQLite reporting tables, data warehouses, Parquet/CSV exports).
- UI dashboards or charting frameworks.
- Distributed reporting or map-reduce aggregation.
- Autonomous harness or Reflex optimization based on reports.
- Commercial model dependencies or cloud reporting endpoints.

## Consequences
- Evaluation outcomes and metrics can be inspected deterministically through immutable report contracts.
- Comparisons between candidate configurations and baselines are explicit, transparent, and mathematically bounded.
- The separation between runtime execution authority and descriptive evaluation analysis is strictly preserved.
