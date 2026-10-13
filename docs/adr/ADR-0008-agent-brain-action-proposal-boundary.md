# ADR-0008: Agent Brain Interface & Governed Action Proposal Boundary

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
- [Runtime Architecture](../architecture/runtime.md)

---

## 1. Context & Problem Statement

In Emerald Agent Fabric, Phase 5 establishes the boundary between bounded runtime observations and external agent decision systems:

```text
ContextSnapshot
      ↓
Agent Brain / Model Port
      ↓
untrusted ActionProposal
      ↓
ProposalValidator (11-Stage Pipeline)
      ↓
trusted Action domain
      ↓
Existing Phase 4 Governance & Execution (WorkerRuntime ↔ ToolExecutionGateway)
```

In autonomous agent systems, a fatal design flaw is granting models or LLM agent frameworks direct tool execution authority (`model -> execute tool`). This leads to severe security vulnerabilities, governance bypass, and state corruption:
1. **Direct Tool Invocation**: If a model directly executes a tool adapter, it completely bypasses Mission Contracts, capability authorization, workspace sandboxing, and resource ceilings.
2. **Authority Hallucination & Injection**: Untrusted models can fabricate authority fields, claiming to have specific `workerId`, `leaseId`, `contractId`, `contractVersion`, elevated `capabilities`, or root permissions.
3. **Execution Result Fabrication**: Models can propose that an action has already `SUCCEEDED` with a fabricated `resultPayload`, bypassing physical verification entirely.
4. **Stale Proposal Replay**: A proposal generated against an earlier state can be replayed out of order if not cryptographically bound to the active `ContextSnapshot`.
5. **Arbitrary Resource Ceilings**: A model might request unlimited timeouts or output sizes unless bounded against immutable Mission Contract resource limits.
6. **Path Traversal & Shell Escapes**: Untrusted model arguments can attempt directory traversal (`../../etc/passwd`) or shell injection.

---

## 2. Decision & Architectural Principles

We establish `AgentBrainPort`, `ActionProposal`, and `ProposalValidator` with the following non-negotiable architectural guarantees:

### 2.1 Model Output Is Strictly Untrusted
Model output is treated as untrusted data until it traverses the complete, unskippable 11-stage validation pipeline in `ProposalValidator`.

### 2.2 Zero Provider Invocation Invariant
Neither `AgentBrain.proposeAction(...)` nor `ProposalValidator.validate(...)` ever invokes a `ToolAdapter` or `ExecutionProvider`. Proposal generation and validation have `providerInvocationCount === 0`.

### 2.3 Strict Authority Field Prohibition (Fail-Closed)
Models may ONLY propose:
- `proposalId`: string (unique generation identifier)
- `toolName`: ToolName
- `inputPayload`: Record<string, unknown>
- `contextSnapshotHash`: 64-character SHA-256 hex string
- `rationale`?: string (optional, bounded to 4096 chars)
- `sequenceHint`?: number (optional integer hint)

Models are **strictly prohibited** from proposing or controlling runtime authority:
`workerId`, `leaseId`, `contractId`, `contractVersion`, `contractHash`, `contractBinding`, `capability`, `capabilities`, `requiredCapability`, `resourceCeilings`, `resourceLimits`, `limits`, `timeoutMs` (at top-level), `isolationLevel`, `isolationRequirement`, `workspaceRoot`, `hostPath`, `mountPath`, `provider`, `image`, `container`, `network`, `credentials`, `secret`, `token`, `retry`, `maxAttempts`, `attemptNumber`, `executionStatus`, `status`, `executionResult`, `result`, `resultPayload`, `errorPayload`, `exitCode`, `evidence`, `verification`, `verificationResult`.

Any proposal containing these fields is immediately rejected with reason code `FORBIDDEN_AUTHORITY_FIELD`.

### 2.4 Cryptographic Context Binding
Every proposal must declare `contextSnapshotHash`. The validator asserts:
`proposal.contextSnapshotHash === contextSnapshot.contextHash`
If they do not match, the proposal is rejected with `CONTEXT_HASH_MISMATCH`, preventing stale or out-of-order execution proposals.

### 2.5 Zero Database Mutation on Rejection
When a proposal is rejected, **zero** `Action` records and **zero** `Attempt` records are created or persisted. Rejected proposals are ephemeral and leave the authoritative database completely untouched.

### 2.6 Authoritative Action Aggregate Creation
When a proposal passes all 11 stages, `createActionFromProposal` constructs the authoritative `Action` aggregate using:
- `actionId`: fresh cryptographic UUID
- `runId`: authoritative from `RunSnapshot` (never model)
- `sequenceNumber`: authoritative next sequence number from store (never model)
- `toolName`: validated tool name
- `inputPayload`: deeply frozen validated tool input
- `contractBinding`: authoritative from `run.contractBinding` (never model)
- `maxAttempts`: authoritative from `contract.spec.resourceLimits.maxAttempts` (never model)

---

## 3. The 11-Stage Validation Pipeline

```text
[Stage 1]  Payload Size Ceilings (<= 64 KB)
     ↓
[Stage 2]  Structural Parsing & Forbidden Authority Detection
     ↓
[Stage 3]  Schema Conformance & Rationale Length (<= 4096 chars)
     ↓
[Stage 4]  Context Snapshot Hash Matching
     ↓
[Stage 5]  Authoritative Run & Lease Fencing Check (Active & Leased)
     ↓
[Stage 6]  Mission Contract Integrity & ACTIVE Lifecycle Status
     ↓
[Stage 7]  Tool Registry Resolution
     ↓
[Stage 8]  Capability Authorization & Policy Evaluation
     ↓
[Stage 9]  Tool Input Schema & Lexical Path Traversal Validation
     ↓
[Stage 10] Resource Ceiling Bounds Check (timeoutMs, maxBytes <= ceilings)
     ↓
[Stage 11] Success Decision Construction (Deeply Frozen Proposal)
```

---

## 4. Rejection Taxonomy

Rejections are classified with explicit machine-actionable reasons:

| Rejection Reason | Trigger Condition |
| :--- | :--- |
| `MALFORMED_PROPOSAL` | Non-object, missing mandatory fields, invalid JSON structure |
| `PROPOSAL_SIZE_EXCEEDED` | Serialized proposal exceeds 65536 bytes |
| `RATIONALE_TOO_LONG` | Rationale string exceeds 4096 characters |
| `FORBIDDEN_AUTHORITY_FIELD`| Proposal specifies forbidden authority fields |
| `CONTEXT_HASH_MISMATCH` | `contextSnapshotHash` does not match active `ContextSnapshot` |
| `RUN_NOT_ACTIVE` | Run is non-existent, terminal, or not in active RUNNING status |
| `LEASE_INVALID` | WorkerId or LeaseId fencing check fails |
| `CONTRACT_REVOKED` | Bound contract is missing, tampered, DRAFT, or REVOKED |
| `UNKNOWN_TOOL` | Tool is not registered in `ToolRegistry` |
| `UNAUTHORIZED_CAPABILITY` | Tool required capability denied by Mission Contract policy |
| `INVALID_TOOL_INPUT` | Tool input violates schema or contains path traversal |
| `RESOURCE_LIMIT_EXCEEDED`| Requested tool resource exceeds Mission Contract ceilings |

---

## 5. Consequences & Boundaries

### Positive
- Strict separation between model reasoning and runtime authority.
- Untrusted proposals cannot bypass Mission Contracts, capability policies, or resource ceilings.
- Path traversal and malicious parameter injections fail closed before reaching any tool adapter.
- Deterministic, observable, testable, and replayable execution.

### Negative / Trade-offs
- Models cannot unilaterally define multi-tool plans; every action must be individually validated and dispatched.
- Stale context rejection requires re-snapshotting if runtime state advances before proposal submission.
