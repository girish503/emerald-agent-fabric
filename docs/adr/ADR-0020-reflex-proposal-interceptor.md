# ADR-0020: Reflex Proposal Interceptor Architecture

## Status
Accepted

## Context
In Phase 7.6 (ADR-0019), Emerald Agent Fabric established an explicit evaluation condition boundary distinguishing `BASELINE` and `REFLEX` execution modes. However, the runtime engine had no governed architectural insertion point for adaptive control:
```text
AgentStepController
        ↓
    AgentBrain
        ↓
   ActionProposal (UNTRUSTED)
        ↓
 ProposalValidator
        ↓
  PolicyEvaluator
        ↓
ToolExecutionGateway
```

The central research question of Emerald Reflex is:
> *Given an already validated ActionProposal and its current execution context, should the proposal be allowed to continue, deferred, rejected, or replaced by a safer proposal?*

Without a disciplined architectural seam:
1. An adaptive controller might be introduced upstream of `ProposalValidator`, forcing Reflex to operate on unvalidated model hallucinations or prompt-injected structures.
2. An adaptive controller might be introduced downstream of `PolicyEvaluator`, risking conversion into a second authorization layer that could circumvent mission contracts.
3. An adaptive controller might attempt to mutate execution context or expand authority, violating the foundational principle of least privilege.

## Decision
Introduce a pure, provider-independent `ReflexPort` in the execution loop strictly positioned between `ProposalValidator` (Stage 11 validation) and `PolicyEvaluator` (governance authorization):

```text
               AgentBrain
                   │
                   ▼
            ActionProposal (UNTRUSTED)
                   │
                   ▼
           ProposalValidator (11-Stage Pipeline)
                   │
               validated
                   ▼
            ┌────────────┐
            │   Reflex   │
            │    Port    │
            └─────┬──────┘
                  │
            ReflexDecision (ALLOW | REJECT | DEFER)
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

### 1. Decision ≠ Authority
A Reflex decision is an **untrusted control recommendation**. It is NOT authorization:
- `ALLOW`: Reflex recommends that execution may proceed without additional control constraints. `ALLOW` does NOT authorize tool execution and never overrides `CAPABILITY_DENIED` or policy rejections.
- `REJECT`: Reflex recommends that the proposal must not proceed. The loop halts or records the proposal rejection without creating a physical Action attempt.
- `DEFER`: Reflex cannot recommend execution at this time and safely halts execution with an explicit `DEFERRED` terminal state.

### 2. Monotonic Non-Expansion of Authority
Formally established as a permanent Emerald invariant:
$$\text{EffectiveAuthorityAfterReflex} \subseteq \text{EffectiveAuthorityBeforeReflex}$$
- Reflex may constrain or prune proposed actions.
- Reflex may reject or defer actions.
- Reflex must NEVER grant authority that did not already exist.
- Reflex decisions cannot contain capability grants, credential selectors, worker or lease identifiers, or resource limit overrides. Any attempt by Reflex to return authority-bearing keys triggers `ReflexAuthorityExpansionError`.

### 3. Pure Observational Context
`ReflexContext` is strictly immutable, containing only observable runtime facts:
- `runId`, `taskId`, `stepNumber`, `taskDescription`, `failureCount`
- `recentActionHistory` (read-only audit summary)
- `verificationStatus`, `workspacePath`, `resourceUsage`
- `contextHash`: deterministic canonical SHA-256 fingerprint computed via `canonicalJsonStringify` and `redactSensitiveData`

The context contains zero credentials, zero provider clients, zero filesystem handles, zero database connections, and zero mutating methods (`execute()`, `write()`, `delete()`).

### 4. Deterministic No-Op Implementation (`NoopReflex`)
A deterministic no-op implementation is established as the default adapter:
- Returns `ALLOW` with reason code `NO_INTERVENTION`.
- Validates context immutability without mutating proposals or context.
- Invokes zero model providers, zero LLMs, zero tools, and zero Docker containers.
- Does not fake optimization or manipulate experimental baseline metrics.

## Consequences

### Positive
- Establishes a rigorous, governed insertion point for future adaptive reasoning.
- Preserves the existing 11-stage proposal validation boundary intact.
- Enforces defense-in-depth: untrusted model output cannot bypass schema validation, and Reflex recommendations cannot bypass mission contract policies.
- Enables reproducible benchmarking of baseline vs. future reflex implementations against identical task contracts.

### Negative / Limitations
- Adds an asynchronous evaluation step in the step controller loop (sub-millisecond overhead in no-op mode).
- Does not yet implement heuristic, rule-based, or model-based adaptive optimization (deferred to future phases).

## Non-Goals (Explicitly Deferred)
The following are strictly out of scope for Phase 8.1 and intentionally deferred:
- Adaptive optimization algorithms
- Model-based or LLM-driven Reflex evaluations
- Machine learning or reinforcement learning
- Proposal scoring or composite `ReflexScore` calculations
- Counterfactual reasoning
- Dynamic model routing
- Token or latency minimization heuristics
- Persistent database tables or state machine changes
- Benchmark campaigns
