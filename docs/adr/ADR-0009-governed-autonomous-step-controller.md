# ADR-0009: Governed Autonomous Agent Reasoning Loop & Step Controller

## Status
Approved (Architecture Specification Baseline)

## Date
2026-10-13

## Governing Documents
- [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- [ADR-0001: Master Engineering Constitution](./ADR-0001-master-engineering-constitution.md)
- [ADR-0002: Runtime Kernel, Durable State Machine, Leased Worker Coordination, and Append-Only Event Store](./ADR-0002-runtime-kernel-and-durable-state-machine.md)
- [ADR-0003: Workspace Sandbox Boundary and Typed Tool System Architecture](./ADR-0003-workspace-and-typed-tools.md)
- [ADR-0004: Tool Execution Gateway, Adapter Boundary, and Multi-Step Action Lifecycle](./ADR-0004-tool-execution-gateway-and-adapter-boundary.md)
- [ADR-0005: Action and Attempt Domain Architecture, Lifecycle Semantics, and Lease-Fenced Persistence](./ADR-0005-action-and-attempt-domain-architecture.md)
- [ADR-0006: Crash Recovery, UNKNOWN Reconciliation, Retry Safety, and Attempt Sweeper](./ADR-0006-crash-recovery-unknown-reconciliation-retry-safety.md)
- [ADR-0007: Typed Context Engine — Observation Selection, Context Budgeting, and Token Governance](./ADR-0007-context-engine-budgeting-and-observation-selection.md)
- [ADR-0008: Agent Brain Interface & Governed Action Proposal Boundary](./ADR-0008-agent-brain-action-proposal-boundary.md)
- [Runtime Architecture](../architecture/runtime.md)

---

## 1. Context & Problem Statement

In Emerald Agent Fabric, Phase 4 established durable Action/Attempt execution governance, crash recovery, and UNKNOWN safety reconciliation. Phase 5 tasks 5.1 and 5.2 established the typed Context Engine and the untrusted Agent Brain Proposal boundary.

Task 5.3 addresses the core runtime integration: connecting the Context Engine, Agent Brain Port, Action Proposal Validator, and WorkerRuntime into an autonomous iterative reasoning and action loop:

```text
Observe (ContextEngine)
       ↓
Reason & Propose (AgentBrainPort)
       ↓
Validate Proposal (ProposalValidator 11-Stage Pipeline)
       ↓
Execute Action (WorkerRuntime ↔ ToolExecutionGateway)
       ↓
Observe (Fresh ContextSnapshot with cryptographic hash)
       ↓
... repeat until terminal condition ...
```

In typical autonomous agent architectures, execution controllers suffer from severe reliability and security failure modes:
1. **Unbounded Loops & Runaways**: Agents can run forever in infinite loops, burning resources and generating runaway tool executions.
2. **Direct Tool Invocation**: Controllers permit models to invoke tools directly, bypassing capability policies, resource ceilings, and workspace sandboxing.
3. **Lease Drift & Split-Brain Execution**: Controllers execute multi-step actions without validating lease ownership or expiration between steps, causing split-brain execution when worker leases are stolen or expire.
4. **Contract Revocation Blindness**: When a Mission Contract is revoked (e.g., security emergency), un-governed controllers continue executing actions.
5. **UNKNOWN State Mutation & Hallucinated Retries**: When an action's side-effect state becomes uncertain (`UNKNOWN`), unconstrained agents retry destructive operations blindly.
6. **Parallel Execution Drift**: Invoking concurrent actions against the same workspace corrupts filesystem state and causal event ordering.
7. **Ephemeral Information Leakage**: Rejections or failures are not deterministically tracked in structured audit transcripts.

---

## 2. Decision & Architectural Principles

We implement `AgentStepController` as a strictly bounded, governed autonomous reasoning loop with the following non-negotiable architectural guarantees:

### 2.1 Untrusted Agent Brain Model Independence
`AgentStepController` communicates with external reasoning systems exclusively through `AgentBrainPort`. The controller contains zero model SDKs (no OpenAI, Anthropic, Gemini, or LangChain SDKs). All outputs from `AgentBrainPort` are treated as untrusted proposals.

### 2.2 Zero Direct Execution Invariant
The `AgentStepController` never directly invokes tools or execution providers:
$$\text{providerInvocationCount} = 0$$
All physical tool executions are dispatched strictly through `WorkerRuntime.executeAction(...)`, which enforces Mission Contract authorization, capability checks, resource ceilings, and lease fencing through `ToolExecutionGateway`.

### 2.3 Comprehensive Multi-Dimensional Step Budgets
Every step loop execution is governed by an immutable `StepControllerBudget`:
- `maxSteps` (default: 10): Maximum number of reasoning loop iterations.
- `maxWallClockMs` (default: 60,000 ms): Total wall-clock duration limit across all steps.
- `maxActions` (default: 10): Maximum physical actions executed.
- `maxConsecutiveFailures` (default: 3): Loop terminates if consecutive actions fail without intermediate success.
- `maxProposalRejections` (default: 3): Loop terminates if consecutive or cumulative proposals fail validation.

### 2.4 Pre-Step and Pre-Execution Double Fencing
Every reasoning step verifies authoritative Run state, lease ownership, and lease expiration:
1. **Pre-Step Check**: Verified before gathering context observations and calling the Agent Brain.
2. **Pre-Execution Check**: Verified immediately after proposal validation, prior to dispatching `WorkerRuntime.executeAction(...)`.
If lease ownership is lost (`run.leaseId !== leaseId` or `run.currentWorkerId !== workerId`) or expired (`nowIso >= run.leaseExpiresAt`), the controller halts immediately with `LEASE_LOST`.

### 2.5 Active Mission Contract Verification
The controller verifies that the bound Mission Contract is in `ACTIVE` status:
1. Pre-step verification.
2. ProposalValidator Stage 6 verification.
3. Pre-execution verification.
If the contract is revoked or missing, the controller halts immediately with `CONTRACT_REVOKED`.

### 2.6 Cooperative Cancellation via AbortSignal
`AgentStepController.runStepLoop(...)` accepts an optional `AbortSignal`. The signal is inspected at the beginning of each step and immediately prior to action dispatch. If triggered, the controller halts with `CANCELLED`.

### 2.7 Serial Action Execution Invariant
The controller enforces serial action execution: exactly one Action aggregate is created and executed per step. Parallel actions within a single run are strictly prohibited.

### 2.8 Fail-Closed UNKNOWN Execution Safety Stop
If an action execution yields an `UNKNOWN` Attempt/Action status (e.g., timeout, crash, process uncertainty), `AgentStepController` halts immediately with terminal reason `UNKNOWN_EXECUTION`:
- The controller never masks `UNKNOWN` as a recoverable failure.
- The controller never invites the Agent Brain to retry or guess.
- Authoritative reconciliation is delegated to Phase 4 crash recovery and sweeper mechanisms.

### 2.9 Ephemeral Proposal Rejections
When `ProposalValidator` rejects an untrusted proposal:
- Zero `Action` and zero `Attempt` records are created or persisted in SQLite.
- The proposal rejection is recorded in the step transcript.
- Consecutive rejection counters are incremented.
- The model receives feedback in the next context snapshot observations if within budget.

### 2.10 Structured In-Memory Step Transcript
Every execution produces an immutable `StepTranscriptEntry` per step capturing:
- `stepNumber`, `timestamp`, `durationMs`
- `contextSnapshotId`, `contextHash`, `contextEstimatedTokens`, `contextBytes`, `contextObservationsCount`
- `proposalId`, `toolName`, `rationale`, `finishReason`
- `proposalValid`, `proposalRejectionReason`, `proposalRejectionMessage`
- `actionId`, `attemptCount`, `actionStatus`, `errorPayload`

### 2.11 Deterministic Terminal Reason Taxonomy
The controller concludes execution with an explicit terminal reason from `StepControllerTerminalReason`:
- `COMPLETED`: Agent brain reached goal (`GOAL_REACHED`).
- `NO_ACTION`: Agent brain declared no action required or omitted proposal.
- `MAX_STEPS`: Exceeded step budget ceiling.
- `MAX_WALL_CLOCK`: Exceeded total wall-clock time ceiling.
- `MAX_ACTIONS`: Exceeded physical action execution ceiling.
- `MAX_FAILURES`: Exceeded consecutive action failure ceiling.
- `MAX_PROPOSAL_REJECTIONS`: Exceeded proposal rejection ceiling.
- `CANCELLED`: AbortSignal aborted.
- `LEASE_LOST`: Worker lease ownership lost or expired.
- `CONTRACT_REVOKED`: Mission Contract revoked or inactive.
- `UNKNOWN_EXECUTION`: Action side-effect uncertainty encountered.
- `CONTEXT_BUDGET_EXCEEDED`: Observations exceed context budget ceilings.
- `BRAIN_FAILURE`: Agent Brain threw unhandled exception or returned `ERROR`.

---

## 3. Invariants & Proof of Correctness

1. **Zero Provider Invocations in Controller**: The step controller does not import or call `ExecutionProvider` or tool adapters directly.
2. **Zero Database Migrations**: Task 5.3 requires zero new database tables; all operational state persists through existing Phase 4 tables (`runs`, `actions`, `attempts`, `run_events`).
3. **Lease Isolation**: A worker cannot execute actions once its lease has expired or been reassigned to another worker.
4. **Provable Context Provenance**: Each proposal must match `contextSnapshotHash === contextSnapshot.contextHash`; mismatched proposals are rejected with `CONTEXT_HASH_MISMATCH`.
5. **Fail-Closed on Uncertainty**: Any `UNKNOWN` execution result halts execution immediately.

---

## 4. Consequences & Revisit Conditions

### Positive Consequences
- Establishes the first governed autonomous agent execution loop in Emerald Agent Fabric.
- Preserves all Phase 4 guarantees (capability governance, resource ceilings, workspace sandboxing, durable persistence, UNKNOWN safety).
- Fully testable with deterministic scriptable brain without real model calls or network dependencies.

### Revisit Conditions
- When multi-agent coordination or subagent delegation is introduced.
- When dynamic harness evolution or adaptive reflex policies are integrated.
