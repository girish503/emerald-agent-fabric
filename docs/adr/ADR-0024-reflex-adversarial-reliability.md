# ADR-0024: Reflex Adversarial Reliability and Invariant Evaluation

## Status
Accepted

## Context
Across Phases 8.1 through 8.4, Emerald Agent Fabric established:
1. **Governed Reflex Interceptor Seam** (`src/domain/reflex.ts`): Positioned strictly between untrusted proposal validation and authoritative policy evaluation.
2. **Deterministic Rule-Based Reflex Heuristics** (`src/adapters/reflex/rule-based-reflex.ts`): Implemented three explainable rules (`reflex.failure-loop.v1`, `reflex.redundant-action.v1`, `reflex.budget-pressure.v1`).
3. **Controlled Empirical Evaluation** (`src/application/evaluation/controlled-evaluation.ts`): Proved under canonical tasks that Reflex reduces futile execution without harming productive task completion.
4. **Reflex Evidence & Offline Replay** (`src/domain/reflex-evidence.ts`): Produced tamper-evident observational records allowing offline verification without models, tools, SQLite, or containers.

### Research Question
> Does Reflex remain governance-safe and deterministic when its inputs contain adversarial, ambiguous, stale, conflicting, malformed, or execution-uncertain runtime state?

This phase does NOT introduce machine learning, adaptivity, model routing, or new heuristics. It subjects the frozen Phase 8.4 architecture to an adversarial reliability and invariant evaluation suite.

## Decision

### 1. Adversarial Threat Model & Fixture Suite
Establish a deterministic adversarial fixture suite in `src/application/evaluation/reflex-adversarial-fixtures.ts`:
- **Authority Injection**: Untrusted proposals, observational contexts, or forged decisions attempting to inject runtime credentials, capabilities, contract IDs, worker IDs, lease IDs, or isolation overrides.
- **Context Hash Confusion**: Mismatches between proposal `contextSnapshotHash`, context `contextHash`, and evidence records.
- **Configuration Tampering**: Tampered thresholds, disabled rules, reordered rules, or forged `ruleConfigurationHash` values.
- **Stale Observations**: Histories containing outdated step sequences, stale verification results, or state changes that break failure streaks.
- **Conflicting Observations**: Successes interleaved with failures, alternating tool invocations, or identical tools with differing inputs.
- **UNKNOWN Execution Outcomes**: Preserving `UNKNOWN` status without converting it to `SUCCESS` or resetting failure streaks.
- **Budget Boundary Conditions**: Evaluating exact behavior around $0\%$, $\text{threshold} - \epsilon$, exact $\text{threshold}$, $\text{threshold} + \epsilon$, and $100\%$ resource utilization.
- **Malformed Evidence**: Bounded payload violations ($> 64\text{ KB}$), missing fields, invalid hashes, unknown reason codes, and secret injection.

### 2. Authority Monotonicity Invariant
Enforce the fundamental invariant:
$$\text{EffectiveAuthorityAfterReflex} \subseteq \text{EffectiveAuthorityBeforeReflex}$$
- Reflex decisions (`ALLOW`, `REJECT`, `DEFER`) are untrusted recommendations.
- Decisions can NEVER expand permissions, grant capabilities, override isolation, extend timeouts, or alter mission contracts.
- Any decision or context attempting authority injection is rejected immediately via `assertReflexAuthorityInvariant` and strict Zod superRefine firewalls, throwing `ReflexAuthorityExpansionError` or `InvalidReflexContextError`.

### 3. Policy-Bypass & Execution-Bypass Resistance
Reflex is NOT an authorization source:
- An `ALLOW` decision emitted by Reflex does NOT authorize tool execution.
- Downstream governance (`PolicyEvaluator` and `ToolExecutionGateway`) remains completely authoritative.
- An agent proposing an unauthorized tool (e.g., `run_command` under a read-only mission contract) is blocked downstream with `CAPABILITY_DENIED`, regardless of whether Reflex recommended `ALLOW`.
- Zero provider invocations occur for unauthorized proposals (`providerInvocationCount === 0`).

### 4. Epistemic Integrity of UNKNOWN Outcomes
- Execution attempts ending in `UNKNOWN` (crashes, disconnects, worker lease expirations) are preserved fail-closed.
- `RuleBasedReflex` counts `UNKNOWN` toward the failure loop streak (`status === "FAILED" || status === "UNKNOWN" || status === "TIMED_OUT"`).
- `UNKNOWN` is never rewritten to `SUCCESS`, does not trigger unsafe automatic retries, and never fabricates successful evidence.

### 5. Replay Tamper Resistance & Side-Effect Freedom
- Replay (`replayReflexEvidence`) remains strictly offline: zero LLM calls, zero tool executions, zero database writes, and zero container operations.
- Direct mutations to recorded evidence (modifying decisions, reasons, rules, or hashes) violate the cryptographic `evidenceIdentityHash` and result in `INVALID_EVIDENCE`.
- Inconsistencies between recorded context hashes and recomputed context hashes produce `MISMATCH_CONTEXT`.
- Inconsistencies between active evaluator configuration and recorded configuration produce `MISMATCH_CONFIGURATION`.

### 6. Strict Precedence Hierarchy
Deterministic rule precedence is preserved:
$$\text{Failure Loop} > \text{Redundant Action} > \text{Budget Pressure} > \text{ALLOW}$$
When multiple conditions are simultaneously satisfied, higher-priority rules reliably preempt lower-priority rules.

### 7. Baseline Non-Interference
- When running in `BASELINE` mode (`NoopReflex`), Reflex telemetry (`reflexEvaluations`, `reflexAllows`, `reflexRejects`, `reflexDefers`, `ruleTriggerCounts`) remains `undefined`.
- Absence is strictly preserved and never represented as zero.
- No `ReflexEvidence` records are fabricated or emitted during baseline runs.

### 8. Security Regression Matrix
| Threat | Expected Outcome | Verified Mechanism |
|---|---|---|
| Authority Injection | Rejected | `assertReflexAuthorityInvariant` throws `ReflexAuthorityExpansionError` |
| Capability Expansion | Rejected | `findForbiddenAuthorityKeys` detects capability override |
| Resource Expansion | Rejected | Decision schema rejects `resourceLimits` / `timeoutMs` |
| Workspace Expansion | Rejected | Decision schema rejects `workspaceRoot` |
| Provider Substitution | Rejected | Decision schema rejects `provider` / `image` |
| Contract Substitution | Rejected | Decision schema rejects `contractId` / `contractVersion` |
| Credential Injection | Rejected | `isSensitiveKey` firewall throws `InvalidReflexContextError` |
| Stale Evidence | Mismatch/Reject | `replayReflexEvidence` returns `MISMATCH_CONTEXT` |
| Tampered Configuration | Mismatch/Reject | `replayReflexEvidence` returns `MISMATCH_CONFIGURATION` |
| Malformed Context | Rejected | `validateReflexContext` throws `InvalidReflexContextError` |
| UNKNOWN Reinterpretation | Impossible/Fail Closed | Preserved in history; counts toward failure loop streak |
| Unauthorized Tool | Policy Denied | `PolicyEvaluator` / `ToolExecutionGateway` denies execution |
| Replay Side Effects | Impossible | In-memory evaluation only; 0 tool/model/DB calls |
| Baseline Reflex Execution | Impossible | `NoopReflex` returns default ALLOW without evidence capture |

## Consequences

### Positive
- Formal verification that Reflex cannot become a vector for privilege escalation or sandbox escapes.
- Proven deterministic replay under adversarial state.
- Unaffected baseline evaluation semantics for future experimental comparisons.

### Limitations
- **Scope**: This phase evaluates safety properties of the existing Reflex implementation. It does not improve or tune the Reflex implementation.
- **Rule Expressiveness**: Heuristics remain strictly rule-based and do not perform deep semantic analysis of code or diffs.
