# ADR-0026: Reflex Overhead, Calibration & Extended Evaluation

## Status
Accepted

## Context
Through Phases 8.1 through 8.6, Emerald Agent Fabric established:
1. **Governed Reflex Interceptor Seam** (`src/domain/reflex.ts`): Positioned strictly between untrusted proposal validation and authoritative policy evaluation.
2. **Deterministic Rule-Based Reflex Heuristics** (`src/adapters/reflex/rule-based-reflex.ts`): Implemented three explainable rules (`reflex.failure-loop.v1`, `reflex.redundant-action.v1`, `reflex.budget-pressure.v1`).
3. **Controlled Empirical Evaluation** (`src/application/evaluation/controlled-evaluation.ts`): Verified canonical Tasks A through D under controlled condition pairs.
4. **Reflex Evidence & Offline Replay** (`src/domain/reflex-evidence.ts`): Produced tamper-evident observational records allowing offline deterministic replay.
5. **Adversarial Reliability & Invariant Evaluation** (`tests/application/reflex-adversarial.test.ts`): Proved authority monotonicity and fail-closed containment when Reflex receives hostile or ambiguous state.
6. **Fault Injection & Fail-Safe Recovery** (`tests/application/reflex-fault-injection.test.ts`): Proved that Reflex runtime failures fail closed with zero tool dispatches.

### Research Question
> What is the execution cost, intervention rate, stability, and observed task-level impact of the frozen Reflex controller as workload length and trial count increase?

Phase 8.7 is strictly a **measurement and calibration phase**, NOT an optimization or adaptive-control phase.

## Decision

### 1. Semantic Freeze & Configuration Binding
The `RuleBasedReflex` heuristics, thresholds, and precedence order are byte-for-byte frozen:
- Precedence: `reflex.failure-loop.v1` > `reflex.redundant-action.v1` > `reflex.budget-pressure.v1` > `ALLOW`.
- Configuration: Bound to `FROZEN_RULE_BASED_REFLEX_CONFIG_HASH` (`5e71ea253972678379f2e16c145d4b314e8de1b70c9eb0ac69d7a51540376252`).
- Threshold modifications are rejected as regression.

### 2. Extended Controlled Evaluation Suite (Tasks E–I)
The canonical suite (Tasks A–D) is extended with five deterministic workloads:
- **Task E (`task-baseline-reflex-multi-step-normal`)**: Multi-step productive workflow (read $\to$ transform $\to$ verify) measuring baseline vs reflex under intervention-free conditions.
- **Task F (`task-baseline-reflex-long-sequence`)**: 6-stage sequential transformation pipeline measuring cumulative reflex latency overhead over longer trajectories.
- **Task G (`task-baseline-reflex-intermittent-failure`)**: Intermittent recoverable errors separated by successful actions, measuring failure-loop streak reset mechanics.
- **Task H (`task-baseline-reflex-mixed-workload`)**: Mixed workload containing normal steps, a transient failure, a redundant loop, and final recovery, observing both `ALLOW` and `REJECT` decisions in a single transcript.
- **Task I (`task-baseline-reflex-near-threshold`)**: Workload that operates near (but does not cross) the budget-pressure threshold, verifying absence of false `DEFER`/`REJECT` interventions.

### 3. Repeated Trial Matrix & Stability Metrics
- Controlled experiments support configurable trial counts ($N \ge 1$, default $N=10$).
- Each trial runs in an isolated ephemeral execution sandbox with unique trial identifiers and timestamps.
- **Reflex Stability Metrics** (`ReflexStabilityMetrics`) quantify:
  - `isDecisionConsistent`: Boolean indicating identical decision sequence across all $N$ trials.
  - `isRuleTriggerConsistent`: Boolean indicating identical rule triggers across all $N$ trials.
  - `interventionCountDistribution`: Frequency map of intervention counts.
  - `uniqueDecisionSequencesCount`: Cardinality of distinct decision sequence signatures.

### 4. Reflex Overhead Telemetry
- Monotonic execution duration of `ReflexPort.evaluate()` is measured at the step controller via `performance.now()` and accumulated as `metrics.reflexLatencyMs`.
- Metric direction is declared as `LOWER_IS_BETTER` in statistical analysis.
- Baseline trials strictly preserve `undefined` for `reflexLatencyMs` and all Reflex evaluation counters.

### 5. Reflex Intervention & Ground-Truth False-Positive Metrics
- `ReflexInterventionMetrics` computes:
  - `reflexInterventionRate`: Total interventions divided by total proposals evaluated.
  - `reflexRejectionRate`: Rejections divided by total proposals evaluated.
  - `reflexDeferralRate`: Defers divided by total proposals evaluated.
  - `reflexAllowanceRate`: Allows divided by total proposals evaluated.
  - `falsePositiveInterventions` / `falsePositiveRate`: Strictly defined only for intervention-free tasks where any intervention is objectively non-essential (Task A, Task E, Task F, Task G, Task I). For intentional intervention scenarios (Tasks B, C, D, H), this metric remains strictly `undefined`.

### 6. Descriptive Statistics & Non-Causal Comparison
- Adheres to Section 34 of `GEMINI.md`:
  - Wilson score confidence intervals for binomial metrics (`objectivePassRate`).
  - Student's t distribution statistics (mean, variance, margin of error) for continuous metrics (`steps`, `actions`, `wallClockMs`, `toolCalls`, `reflexLatencyMs`).
  - Summary metrics: sample count, mean, min, max, std dev.
  - Zero p-values, hypothesis tests, or causal claims.

### 7. Experiment Manifest & Reproducibility
- `ExperimentManifest` captures the immutable declared configuration of every controlled experiment.
- Canonical JSON hashing deterministically fingerprints: task IDs (sorted), execution modes (sorted), trial count, model provider, model, harness version, and rule configuration hash.
- Sensitive credential keys (e.g. `apiKey`, `token`) in generation options are deterministically redacted before hashing and storage.

## Consequences

### Positive
- Reliable empirical measurement of the CPU/latency cost of deterministic Reflex heuristics.
- Quantified decision stability across repeated trials ($N=10$).
- Clean separation between ground-truth intervention-free workloads and deliberate intervention scenarios.
- Strict preservation of control group integrity (`BASELINE` metrics are never zero-fabricated).

### Limitations
- **Synthetic Task Suite**: Extended tasks are hermetic scripted workloads designed for reproducible characterization; they are not generalized web/repository benchmarks.
- **No Optimization**: Measurements indicate negligible CPU overhead ($<1\text{ ms}$ per evaluation), but zero optimization or code refactoring was performed.
