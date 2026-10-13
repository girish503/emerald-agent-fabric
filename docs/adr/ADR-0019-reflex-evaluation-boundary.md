# ADR-0019: Reflex Evaluation Condition Boundary

## Status
Accepted

## Context
Across Phases 7.1 through 7.5, Emerald Agent Fabric established a reproducible, multi-task evaluation harness:
1. **Evaluation Tasks & Objective Criteria** (Phase 7.1, ADR-0014)
2. **Immutable Repeatable Trial Records** (Phase 7.2, ADR-0015)
3. **Controlled Evaluation Experiments & Task Fencing** (Phase 7.3, ADR-0016)
4. **Descriptive Reporting & Baseline Comparisons** (Phase 7.4, ADR-0017)
5. **Statistical Evaluation Analysis Contracts** (Phase 7.5, ADR-0018)

The central research question for Emerald Reflex is:
> *Can an adaptive control layer reduce latency, model calls, token consumption, and unsafe actions of autonomous agents without reducing task success?*

To investigate this question scientifically, Emerald requires an explicit experimental condition boundary that enables comparing the existing governed runtime against a future adaptive Reflex runtime under the exact same evaluation methodology. Without this seam, either:
1. The evaluation framework would have to conflate harness configuration with execution architecture, or
2. Reflex components would be introduced ad-hoc without baseline comparison fencing.

## Decision
Introduce an explicit `EvaluationExecutionMode` domain contract and condition-level boundary:
- `BASELINE`: Existing governed `AgentStepController` execution without an adaptive Reflex control layer.
- `REFLEX`: Reserved for execution through the future Emerald Reflex control layer.

### 1. Architectural Boundary Separation
The evaluation condition specifies *which execution mode is being evaluated*; it does *not* implement execution logic or grant runtime authority.

```text
Evaluation Condition (BASELINE | REFLEX)
       │
       ▼
Evaluation Runner (Preflight Mode Support Check)
       │
       ├── BASELINE → Existing Governed Step Loop (AgentStepController)
       │
       └── REFLEX   → Future Reflex Control Layer Boundary (fails closed until implemented)
```

### 2. Explicit Preflight Rejection (No Silent Fallback)
Because the Reflex adaptive controller is not yet implemented, any attempt by the evaluation runner to execute a trial under `REFLEX` mode must fail explicitly and safely:
- Throws `ReflexNotImplementedError` with machine-actionable error code `REFLEX_NOT_IMPLEMENTED`.
- Rejection occurs during preflight, *before* creating a runtime `Run`, registering a worker, provisioning a workspace, or dispatching inference.
- Silent fallback or downgrade (`REFLEX → BASELINE`) is strictly prohibited, as silent fallback would pollute experimental datasets with misrepresented trials.

### 3. Condition Identity Incorporates Execution Mode
`EvaluationExperimentCondition` incorporates `executionMode` into its canonical SHA-256 `conditionHash`.
- `BASELINE + configFingerprint` and `REFLEX + configFingerprint` produce distinct condition hashes.
- `EvaluationConfigFingerprint` semantics remain untouched, preserving backward compatibility and historical trial readability.

### 4. Reflex Position in Runtime Architecture
When implemented in future phases, the Reflex controller will sit *inside* the governed loop between untrusted proposals and policy evaluation:

```text
AgentStepController
        ↓
     AgentBrain
        ↓
   ActionProposal (UNTRUSTED)
        ↓
   [Reflex Layer] (Future: Prune, Defer, Constrain)
        ↓
PolicyEvaluator / ProposalValidator
        ↓
ToolExecutionGateway
        ↓
Workspace / Sandbox
```

### 5. Reflex Safety Invariant (Monotonic Authority Reduction)
The future Reflex layer must be strictly monotonic with respect to governance authority:
> **Reflex Safety Invariant**: Reflex may reduce, constrain, defer, or reject what the agent attempts, but it may never expand, escalate, or bypass what the agent is authorized to do.

Reflex may:
- Reject an action proposal
- Defer an action proposal
- Request another proposal
- Select a safer alternative within authorized scope
- Halt execution early
- Prune redundant work

Reflex may **NEVER**:
- Grant capabilities
- Modify `MissionContract` authority
- Bypass `ProposalValidator` or `ToolExecutionGateway`
- Select credentials or credential scopes
- Select worker or lease identity
- Weaken sandbox or workspace isolation
- Override objective verification requirements

### 6. Multi-Objective Research Boundary
Reflex evaluation is inherently multi-dimensional and cannot be collapsed into a single scalar score:
1. **Primary Outcome**: Objective Task Success (`verificationPassed`)
2. **Efficiency Outcomes**: Model calls, tool calls, wall-clock latency, model latency, tool latency, prompt tokens, output tokens, total tokens
3. **Safety & Governance Outcomes**: Blocked actions, proposal rejections, execution failures, unknown execution outcomes

No composite `ReflexScore` or `ReflexEfficiencyScore` is introduced. Token savings achieved at the expense of task success do not constitute an improvement.

### 7. Controlled Experimental Methodology
The default controlled experiment isolates the execution mode by holding all other variables constant:
- Same `taskId`, `taskVersion`, `taskContentHash`
- Same `MissionContract` & `Policy`
- Same workspace constraints & initial fixture
- Same objective success criteria & verification specs
- Same model provider, model, & generation parameters
- Same resource limits & budget ceilings
- **Only variable**: Execution mode (`BASELINE` vs `REFLEX`)

## Scientific Limitations
1. **Observational vs. Causal Interpretation**: Observed differences between `BASELINE` and `REFLEX` represent empirical associations within the tested sample. Causal attribution requires rigorous experimental isolation and replication.
2. **Model Non-Determinism**: Identical declared configuration does not guarantee identical token sequences, latency, or scheduling across runs. Repeated independent trials remain mandatory.

## Non-Goals
This ADR explicitly excludes:
- Implementing the Reflex adaptive controller
- Action scoring, confidence scoring, or counterfactual prediction
- Action pruning, tool selection optimization, or model routing
- Token optimization algorithms or prompt compression
- Persistent Reflex tables, state stores, Redis, or vector databases
- Benchmark campaigns or automated prompt evolution
- Synthetic Reflex metrics or fabricated token savings

## Consequences
- Evaluation conditions can explicitly declare `BASELINE` or `REFLEX`.
- The evaluation runner protects experimental integrity by failing closed on unimplemented `REFLEX` conditions (`REFLEX_NOT_IMPLEMENTED`).
- Controlled condition comparability is verified deterministically before trials are executed or compared.
- Historical trials and existing configuration fingerprints remain 100% valid and backward compatible.
