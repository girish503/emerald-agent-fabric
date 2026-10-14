# ADR-0021: Deterministic Rule-Based Reflex Heuristics

## Status
Accepted

## Context
Phase 8.1 (ADR-0020) established the governed Reflex proposal interceptor architecture:
```text
AgentBrain
    │
    ▼
ActionProposal (UNTRUSTED)
    │
    ▼
ProposalValidator (11-Stage Pipeline)
    │
    ▼
ReflexPort (ALLOW | REJECT | DEFER)
    │
    ▼
PolicyEvaluator (MissionContract)
    │
    ▼
ToolExecutionGateway
    │
    ▼
Workspace / Sandbox
```

In Phase 8.1, the only concrete adapter was `NoopReflex`, which universally returns `ALLOW` with reason code `NO_INTERVENTION`. While this validated the interceptor wiring and established the invariant of monotonic authority reduction, the runtime lacked any adaptive defense against common autonomous agent failure modes:
1. **Failure Loops**: An agent repeatedly proposes the exact same failing command or tool input in an unrecovered loop.
2. **Redundant Actions**: An agent issues identical queries (such as re-reading the same file) without any intervening state modifications or context changes.
3. **Budget Exhaustion**: An agent consumes nearly its entire allocation of steps, actions, wall-clock time, or model calls without recognizing budget exhaustion.

The research goal for Phase 8.2 is to implement transparent, deterministic, rule-based heuristics that intervene safely to halt unproductive execution without relying on opaque second agents, machine learning, or statistical guesswork.

## Decision
Implement `RuleBasedReflex` (`src/adapters/reflex/rule-based-reflex.ts`) conforming to `ReflexPort`, controlled by a strongly typed, validated, and canonically hashable configuration (`RuleBasedReflexConfig`).

### 1. Three Deterministic Safety Rules
`RuleBasedReflex` evaluates proposals against three deterministic safety heuristics:

1. **Failure Loop Detection (`reflex.failure-loop.v1`)**:
   - **Trigger**: Proposing a tool invocation with an input payload identical to a prior invocation that has repeatedly failed ($\ge \text{failureThreshold}$, default 3) in recent history without intervening success or state change.
   - **Decision**: `REJECT` with reason code `FAILURE_LOOP_DETECTED`.
   - **Evidence**: Records `ruleId`, `observedCount` (consecutive failed attempts), `threshold`, tool name, and canonical input hash.

2. **Redundant Action Detection (`reflex.redundant-action.v1`)**:
   - **Trigger**: Proposing a tool invocation with an input payload identical to one already executed $\ge \text{redundancyThreshold}$ (default 2) times under the same context without any intervening mutating actions or context changes.
   - **Decision**: `REJECT` with reason code `REDUNDANT_ACTION`.
   - **State Boundary**: Intervening mutating actions (`write_file`, `run_command` with success) and changes in `contextHash` indicate environment evolution and reset redundancy counters. A `read_file` following a `write_file` is not redundant.

3. **Budget Pressure Detection (`reflex.budget-pressure.v1`)**:
   - **Trigger**: Proposing an action when resource usage (step count, action count, wall-clock time, or model calls) exceeds a configured threshold ratio (default 0.90 / 90% of budget limit).
   - **Decision**:
     - At warning threshold ($\ge 90\%$): Non-mutating actions (`read_file`, `git_status`, `git_diff`) are rejected with `BUDGET_EXHAUSTED` to protect remaining budget for goal achievement.
     - At hard ceiling ($\ge 100\%$): All actions are deferred with `DEFER` and reason code `RESOURCE_LIMIT_EXCEEDED`, bringing execution to an orderly halt.

### 2. Deterministic Rule Precedence
Rules are evaluated in strict, deterministic order:
$$\text{Failure Loop} \longrightarrow \text{Redundant Action} \longrightarrow \text{Budget Pressure} \longrightarrow \text{Default ALLOW}$$

If a prior rule fires, evaluation stops immediately, emitting the corresponding structured `ReflexDecision`. If no rule fires or rules are disabled, `RuleBasedReflex` returns `ALLOW` with reason code `NO_INTERVENTION`.

### 3. Action Identity & State Change Tracking
- **Deterministic Canonical Hashing**: Action payload identity is derived from SHA-256 of canonical JSON (`computeCanonicalHash(proposal.inputPayload).contentHash`).
- **State-Aware Boundary**: Only mutating actions (`write_file`, `run_command`) with status `SUCCEEDED` signify environment modification. Read-only actions do not alter filesystem or system state.
- **Fail-Closed Unknowns**: Unverified execution outcomes (`UNKNOWN`) are preserved as non-success and never reset failure streaks or redundancy tracking.

### 4. Monotonic Authority Reduction Invariant
Formally preserved:
$$\text{EffectiveAuthorityAfterReflex} \subseteq \text{EffectiveAuthorityBeforeReflex}$$
`RuleBasedReflex` only emits `ALLOW`, `REJECT`, or `DEFER`. It never returns capability grants, credentials, worker/lease identifiers, or resource ceiling overrides.

### 5. Pure In-Memory Determinism & Zero External Dependencies
- Zero LLM calls or model provider invocations.
- Zero network I/O, child processes, or Docker container interactions.
- Zero SQLite or filesystem persistence modifications.
- Complete execution latency is sub-millisecond ($< 0.5\text{ ms}$).

### 6. Structured Decision Evidence & Observability
Every intervention decision carries an immutable `ReflexDecisionEvidence` payload:
- `ruleId`: e.g. `"reflex.failure-loop.v1"`
- `observedCount`: e.g. consecutive failures or executions
- `threshold`: configured limit
- `evidence`: machine-actionable signals (input hashes, tool names, streak length, budget percentages)

## Consequences

### Positive
- Prevents infinite failure loops and redundant token/tool waste deterministically.
- Preserves full reproducibility: identical inputs and history produce bit-for-bit identical Reflex decisions.
- Completely auditable: every intervention provides explicit rule IDs and evidence.
- Maintains strict governance boundaries: untrusted model proposals cannot bypass schema validation, and Reflex cannot grant execution authority.

### Negative / Limitations
- Does not synthesize alternative actions or repair broken tool inputs (proposals are rejected or deferred, not rewritten).
- Fixed rule thresholds require domain tuning depending on task complexity.

## Non-Goals (Explicitly Deferred)
The following remain strictly out of scope and are intentionally deferred:
- Machine learning, neural networks, or reinforcement learning for Reflex
- Connecting Reflex to an LLM or model provider
- Counterfactual simulation or tree-search planning
- Dynamic model routing or automated prompt mutation
- Automated action rewriting or retry synthesis
- Empirical benchmark campaigns
