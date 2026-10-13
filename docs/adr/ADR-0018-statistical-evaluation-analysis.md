# ADR-0018: Statistical Evaluation Analysis Contracts & Uncertainty Estimation

## Status
Accepted

## Context
Phase 7.1 established immutable evaluation tasks (`EvaluationTaskDefinition`) with objective ground-truth criteria.
Phase 7.2 established immutable, repeatable evaluation trial records (`EvaluationTrial`).
Phase 7.3 established controlled evaluation experiment contracts (`EvaluationExperiment`).
Phase 7.4 established descriptive evaluation reports (`EvaluationReport`) and baseline condition comparison.

While descriptive reporting captures empirical summaries (sums, averages, counts, rates), evaluating agent performance across non-deterministic models and multi-trial runs requires quantifying uncertainty and observed differences without falling into methodological traps (e.g. assuming known population variance, conflating correlation with causation, or asserting statistical significance from unpowered samples).

## Decision
Introduce a pure evaluation analysis layer (`StatisticalAnalysis`) that computes rigorous sample statistics, uncertainty intervals, and directional differences from immutable evaluation records using numerically stable, mathematically defensible methods.

### 1. Mathematical Specifications

#### 1.1 Arithmetic Mean & Welford Sample Variance
For $n$ observed finite values $x_1, x_2, \dots, x_n$:
$$\bar{x} = \frac{1}{n} \sum_{i=1}^n x_i$$
To eliminate catastrophic cancellation caused by naive $\sum x^2 - n \bar{x}^2$ implementations, sample variance is computed via Welford's one-pass recurrence:
$$M_{2, 1} = 0, \quad M_{2, k} = M_{2, k-1} + (x_k - \bar{x}_{k-1})(x_k - \bar{x}_k)$$
$$s^2 = \frac{M_{2, n}}{n - 1} \quad \text{for } n \ge 2$$
$$s = \sqrt{s^2}$$
For $n < 2$, sample variance, sample standard deviation, and confidence intervals are mathematically undefined and remain explicitly `undefined`.

#### 1.2 Standard Error of the Mean
$$SE = \frac{s}{\sqrt{n}}$$

#### 1.3 Student's t Confidence Interval for Numeric Means
Rather than assuming known population variance (which would falsely justify a standard normal z-interval), continuous metrics use Student's t-distribution interval with $n - 1$ degrees of freedom:
$$\bar{x} \pm t_{1 - \alpha/2, \; n - 1} \times SE$$
Critical values $t_{1 - \alpha/2, \; \nu}$ are computed using exact closed-form Cauchy/rational expressions for $\nu \in \{1, 2\}$ and Cornish-Fisher asymptotic expansions around Acklam's probit algorithm for $\nu \ge 3$.
For $n < 2$, confidence intervals remain unavailable (`undefined`).

#### 1.4 Wilson Score Interval for Binary Objective Success Rates
For $k$ successes out of $n$ completed trials at two-sided confidence level $1 - \alpha$:
Let $z = \Phi^{-1}(1 - \alpha/2)$ (Acklam's probit quantile).
$$\tilde{n} = n + z^2$$
$$\tilde{p} = \frac{k + \frac{z^2}{2}}{\tilde{n}}$$
$$\text{margin} = \frac{z}{\tilde{n}} \sqrt{\frac{k(n - k)}{n} + \frac{z^2}{4}}$$
$$\text{CI} = \left[\max(0, \; \tilde{p} - \text{margin}), \; \min(1, \; \tilde{p} + \text{margin})\right]$$
The Wilson score interval guarantees that the point estimate $p = k/n$ remains strictly within $[ \text{lower}, \text{upper} ]$ for all $k \in [0, n]$, avoiding the catastrophic degenerate zero-width intervals of naive Wald intervals at $k = 0$ or $k = n$.
For $n = 0$, the interval remains unavailable (`undefined`).

#### 1.5 Descriptive Differences (Deltas)
- Absolute difference:
  $$\Delta_{\text{abs}} = \text{candidate} - \text{baseline}$$
- Relative difference:
  $$\Delta_{\text{rel}} = \frac{\text{candidate} - \text{baseline}}{\text{baseline}} \quad \text{for } \text{baseline} \ne 0$$
  If $\text{baseline} = 0$, relative difference remains explicitly `undefined` (never `Infinity` or fabricated percentages).

### 2. Methodological Invariants

1. **Analysis Quantifies Observations, Not Causality**:
   > Statistical analysis quantifies observations under the declared experiment design. It does not establish causality by itself.

2. **Scope vs Environmental Equivalence**:
   > Matching task/configuration identity establishes experimental scope, not guaranteed equality of all environmental conditions or model stochasticity.

3. **Independent Observations by Default**:
   > Independent trial analysis is the default unless the experiment explicitly declares paired semantics.
   Trials evaluated on the same task are treated as independent observations, not paired data points. No paired t-tests or dependent sample formulas are assumed.

4. **Zero Execution Authority**:
   > StatisticalAnalysis is a pure evaluation-layer computation and has no execution authority.
   The analysis engine cannot issue leases, modify `MissionContract` instances, invoke tool gateways, interact with Docker, or mutate runtime runs.

5. **Strict Missingness Semantics**:
   Observed zero ($0$) is preserved as a valid numeric observation. Missing/unsupported metrics (`undefined`) are excluded from sample denominators, tracked in `unavailableCount`, and never converted to zero. Non-finite values (`NaN`, `Infinity`) fail closed with explicit errors.

6. **Transparent Methodological Warnings**:
   Limitations such as small sample sizes ($n < 2$), missing data, zero baselines, unequal sample sizes, or wide intervals produce explicit `StatisticalWarning` records rather than silent failures or deceptive certainty.

## Explicit Non-Goals
- Statistical hypothesis testing (p-values, null-hypothesis significance tests).
- Claims of statistical significance or superiority.
- Causal inference or attribution models.
- Paired trial analysis or dependent-sample testing.
- Autonomous Reflex or agent optimization based on statistical outcomes.
- Persistent databases, data warehouses, or reporting dashboards.
- Commercial model dependencies or external statistical microservices.

## Consequences
- Evaluation uncertainty can be rigorously quantified with mathematically audited, dependency-free algorithms.
- Empirical differences between agent conditions are transparent and bounded.
- The separation between runtime execution authority and post-hoc scientific analysis is strictly preserved.
