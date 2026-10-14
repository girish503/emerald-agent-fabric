# ADR-0028: Isolation of Live SWE Experiment Harness and Explicit Entry Point

## Status
Accepted

## Context
In Phase 9 (commit `17b1454`), we introduced realistic multi-file software engineering fixtures (Tasks J–O) and the live SWE evaluation harness. During the initial attempt to execute the live empirical trial matrix, two structural coupling issues were uncovered:

1. **Environment Variable Over-Coupling**: `process.env.OLLAMA_LIVE_TESTS === "true"` was evaluated inside `executeLiveSweEvaluation` such that *every* call—including offline unit tests employing `scripted-model`—was subjected to live Ollama endpoint and model registry checks. As a result, running `vitest` with `OLLAMA_LIVE_TESTS=true` caused mock test cases to fail closed because `"scripted-model"` is not an Ollama repository model.
2. **Smoke Test vs Full Matrix Conflation**: The gated test in `live-swe-evaluation.test.ts` was an integration smoke test (1 task, 2 trials per condition = 4 trials total), lacking a clean, dedicated application entry point for the intended 60-trial experimental matrix (6 tasks × 2 conditions × 5 trials).
3. **Hidden Model-Generation Timeout Ceiling**: In `LiveAgentBrain`, inference timeout was defaulting to an unconfigurable 30,000ms. On CPU-bound local hardware running structured JSON completion with `qwen2.5:3b`, single-step model generation latency was measured at ~25.3s to 30.1s, occasionally breaching the 30-second ceiling and producing premature `modelFailures: 1`.

## Decisions

### 1. Strict Isolation of Offline and Live Execution Paths
Preflight checks against the local Ollama instance (`http://127.0.0.1:11434`) now occur **strictly and exclusively** when `requireLiveOllama: true` is explicitly provided in the evaluation parameters. Offline and mock evaluations run 100% hermetically with zero network or Ollama daemon dependency, regardless of whether `OLLAMA_LIVE_TESTS=true` is present in the host environment.

### 2. Strict, Fail-Closed Model Registry Matching
When live execution is requested (`requireLiveOllama: true`), preflight strictly verifies that the specified model exists in the local Ollama registry. If the model is missing or Ollama is unreachable, execution immediately throws `ModelProviderUnavailableError` and fails closed. The harness **never** silently falls back to a mock provider or an alternate installed model (e.g., falling back to `llama3.2:3b` when `qwen2.5:3b` is requested).

### 3. Separation of Model Generation Timeout vs Task Runtime Timeout
We maintain a strict architectural distinction between:
- **Model Generation Timeout (`modelTimeoutMs`)**: Bound to individual model inference requests through `LiveAgentBrain` and `ModelProviderPort`. This is now an explicit parameter configurable per experiment (defaulting to 120,000ms for CPU-bound local models like `qwen2.5:3b`).
- **Task/Run Timeout (`maxWallClockMs` and `resourceLimits.timeoutMs`)**: Bound to the overall agent step controller budget and containerized tool execution limits, defined by the task's immutable specification.

### 4. Dedicated Phase 9 Experiment Entry Point
We introduce an explicit application-layer entry point for the 60-trial live empirical experiment:
- `createPhase9ExperimentPlan()`: Statically resolves and validates the planned experiment matrix without invoking models.
- `executeLiveSweExperiment()`: Executes the full 60-trial matrix when invoked explicitly.
- `PHASE_9_EXPERIMENT_SPEC`: Canonical constant specifying:
  - Model: `qwen2.5:3b`
  - Tasks: Tasks J–O (`task-swe-bug-fix-calc`, `task-swe-bug-fix-parser`, `task-swe-feature-string-utils`, `task-swe-feature-multi-file`, `task-swe-recoverable-failure`, `task-swe-futile-loop`)
  - Execution Modes: `BASELINE`, `REFLEX`
  - Trials: 5 per task/condition
  - Total Planned Trials: 60
  - Default Model Timeout: 120,000ms

### 5. Invariant: Frozen Reflex Logic Untouched
This is purely a harness architecture correction. The `RuleBasedReflex` implementation, decision precedence, heuristics, thresholds, reason codes, authority invariant ($EffectiveAuthorityAfterReflex \subseteq EffectiveAuthorityBeforeReflex$), and immutable configuration hash (`FROZEN_RULE_BASED_REFLEX_CONFIG_HASH`) remain completely untouched.

## Consequences
- **Positive**: Mock and offline test suites execute 100% deterministically without requiring Ollama, even when `OLLAMA_LIVE_TESTS=true`.
- **Positive**: The 60-trial live experiment has an isolated, typed entry point with explicit 120s model timeout preventing spurious timeouts on CPU hardware.
- **Positive**: Preflight check strictly prevents silent model fallback.
- **Neutral**: The 60-trial live experiment was not run in this phase and remains ready for invocation under controlled conditions.
