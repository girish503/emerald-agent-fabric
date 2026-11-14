# ADR-0044: Durable Multi-Agent Orchestration, Subtask Decomposition, and Fail-Closed Mission Synthesis

## 1. Status
- **Status**: ACCEPTED.
- **Date**: 2026-11-10
- **Relates to**: ADR-0001 (Engineering Constitution), ADR-0002 (Durable State Machine), ADR-0004 (Tool Execution Gateway), ADR-0009 (Agent Step Controller), ADR-0040 (Durable Task Routing & Hierarchical Scheduling), ADR-0043 (Secure REST Verification Contract & Durable Propagation).
- **Not a claim**: This design does not claim to permit unconstrained recursive autonomous subagent spawning or self-approved mission completion; it establishes a strictly typed, DAG-validated, capability-fenced, budget-bounded, and independently verified durable multi-agent orchestration fabric.

---

## 2. Context & Problem Statement

As Emerald Agent Fabric scales to execute complex software-engineering missions (e.g. multi-file refactoring, benchmark exploration, test generation, and security audit), monolithic agent execution encounters fundamental barriers:
1. **Context Saturation & Distraction**: Long-horizon agent step loops accumulate noisy tool outputs, leading to token exhaustion, context degradation, and repetitive/stagnant action loops.
2. **Privilege Over-Provisioning**: Monolithic agents are frequently granted broad tools (`workspace.file.write`, `process.execute`), violating the principle of least privilege for read-only analytical stages.
3. **Absence of Strict Dependency Ordering**: Complex multi-step missions require structured pipelines (e.g. `RESEARCH -> CODE -> TEST -> REVIEW`) with explicit DAG dependency barriers and cascading cancellations.
4. **Vulnerability of Agent Self-Approval**: If a subagent or coordinator can self-certify completion without independent, authoritative verification evidence matching contract specifications, the system risks false-positive goal attainment.

---

## 3. Required Safety & Architectural Invariants

- **Invariant A (Strict DAG Topology & Cycle Prevention)**:
  Decomposition models subtasks as a directed acyclic graph (DAG). Self-loops, duplicate subtask IDs, missing dependency references, and cyclic dependencies (`A -> B -> A`, `A -> B -> C -> A`) are deterministically rejected before any task or run record is created.
- **Invariant B (Ceilings on Fan-Out, Depth, and Resource Budgets)**:
  The decomposition engine strictly enforces structural ceilings:
  - `maxChildrenPerParent`: 10 subtasks.
  - `maxDepth`: 3 levels.
  - Aggregate subtask budgets (`timeoutMs`, `maxAttempts`, `maxOutputBytes`) must never exceed the parent mission's contractual resource limits. Unspecified subtask timeouts default safely to `floor(parentLimits.timeoutMs / N)` to guarantee aggregate boundedness.
- **Invariant C (Role Capability Fencing & Zero Privilege Escalation)**:
  Subagents are assigned explicit, immutable roles (`RESEARCHER`, `CODER`, `TESTER`, `REVIEWER`).
  Every requested capability must strictly satisfy:
  `ChildCapabilities ⊆ ParentCapabilities ∧ ChildCapabilities ⊆ RoleProfile`
  Privilege escalation (e.g. granting `process.execute` to a `RESEARCHER` or `REVIEWER`, or granting capabilities absent from the parent mission) is unconditionally rejected with HTTP 403 / `CapabilityEscalationError`.
- **Invariant D (Durable Routing & Idempotent Scheduling)**:
  Decomposed subtasks are submitted through `TaskRouterService` using canonical decomposition hashes for deduplication. Re-submitting identical decomposition payloads yields the existing subtasks without side effects.
  Active mission coordinators (marked by `subagent.decomposed`) dispatch root subtasks immediately while downstream subtasks wait for their specific DAG dependencies to reach `COMPLETED`.
- **Invariant E (Zero Self-Approval & Independent Verification Gate)**:
  Model self-certification (`isGoalReached`) has zero authority. Child subtask completion is audited against bound verification specifications into explicit verdicts: `VERIFIED`, `REJECTED`, `BLOCKED`, or `UNVERIFIABLE`.
- **Invariant F (Fail-Closed Mission Synthesis)**:
  Mission coordinator synthesis fails closed. The parent mission cannot be marked `SYNTHESIZED` or completed if ANY child subtask is `REJECTED`, `BLOCKED`, or `UNVERIFIABLE`.
- **Invariant G (Cascading Cancellation)**:
  If an upstream subtask fails, times out, or is cancelled, downstream dependent subtasks are immediately transitioned to `CANCELLED`, preventing wasted compute and stale executions.
- **Invariant H (Strict Multi-Tenant Isolation)**:
  All decomposition, hierarchy inspection, and synthesis operations require valid authentication and enforce strict tenant scoping. Cross-tenant access attempts return HTTP 404 with zero data leakage.

---

## 4. Decision & Architecture

### 4.1 Domain Model & Role Contracts (`src/domain/super-agent.ts`)
Subagent roles are strictly enumerated with bounded capability allowances:

```ts
export type SuperAgentRole = "RESEARCHER" | "CODER" | "TESTER" | "REVIEWER";

export const ROLE_CAPABILITY_CONTRACTS: Record<SuperAgentRole, readonly string[]> = Object.freeze({
  RESEARCHER: Object.freeze(["workspace.file.read", "workspace.query"]),
  CODER:      Object.freeze(["workspace.file.read", "workspace.file.write"]),
  TESTER:     Object.freeze(["workspace.file.read", "process.execute"]),
  REVIEWER:   Object.freeze(["workspace.file.read"]),
});
```

DAG validation performs Kahn's topological sort algorithm to verify acyclicity, determine dispatch order, and detect invalid references.

### 4.2 Multi-Agent Orchestrator Service (`src/application/multi-agent-orchestrator.ts`)
The `MultiAgentOrchestrator` coordinates the end-to-end lifecycle:
1. `decomposeMission`: Computes canonical hash, validates DAG, checks resource budgets and role capability fences, registers child tasks and contracts in `StateStore`, maps dependency edges in `TaskRouterService`, and records `subagent.decomposed` and `subagent.spawned` events.
2. `evaluateChildVerification`: Audits worker completion against authoritative verification specifications, generating tamper-evident `subagent.verified` or `subagent.rejected` events.
3. `stepOrchestration`: Advances the orchestration state machine, ticks subtask dispatches, cascades cancellations across dependency edges, and checks mission synthesis readiness.
4. `synthesizeMission`: Evaluates child subtask outcomes. Fails closed (`CANNOT_SYNTHESIZE`) if any child is unverified. Upon all children achieving `VERIFIED`, emits `mission.synthesized` with child run evidence references.
5. `getHierarchy`: Traverses parent-child relationships and returns structured hierarchy trees with subtask roles, statuses, and verification verdicts.

### 4.3 Task Router Extension (`src/application/task-router.ts`)
To resolve the mission coordinator dispatch prerequisite, `TaskRouterService.parentVerdict` checks whether the parent task has recorded a `subagent.decomposed` event. If the parent is an active coordinator, root subtasks of the mission are evaluated as `READY` for immediate execution rather than waiting for the uncompleted mission coordinator to finish.

### 4.4 REST Transport Endpoints (`src/transport/http/server.ts`)
Exposes three frozen multi-agent endpoints:
- `POST /api/v1/tasks/:taskId/decompose`: Validates subtask specifications, enforces role fences and resource ceilings, and creates child tasks (HTTP 201 created or 200 idempotent deduplication; 403 on capability escalation; 404 cross-tenant).
- `GET /api/v1/tasks/:taskId/hierarchy`: Returns complete hierarchical subtask tree with statuses, execution attempts, and verification verdicts (HTTP 200; 404 cross-tenant).
- `POST /api/v1/tasks/:taskId/synthesize`: Synthesizes mission outcomes with fail-closed completion verification (HTTP 200; 400 when blocked; 404 cross-tenant).

---

## 5. Security & Isolation Analysis

1. **Privilege Containment**: Subagents can never acquire capabilities beyond their strict role profile, even if the parent task possesses them. A `RESEARCHER` or `REVIEWER` cannot execute commands or mutate files under any circumstance.
2. **Resource Exhaustion Prevention**: Hard ceilings on fan-out (`maxChildrenPerParent: 10`) and depth (`maxDepth: 3`) combined with aggregate resource limits (`timeoutMs`, `maxAttempts`, `maxOutputBytes`) prevent denial-of-service via fork bombs or runaway decomposition.
3. **Tamper-Evident Replay**: Subtask specifications, dependency edges, and verification outcomes are durably persisted with SHA-256 canonical hashing and sequence numbers.
4. **Tenant Isolation**: All operations are scoped by authenticated tenant ID. Operators from Tenant A cannot decompose, inspect, or synthesize tasks belonging to Tenant B.

---

## 6. Verification Evidence

Validated via `tests/integration/durable-multi-agent-orchestration.integration.test.ts` (10 deterministic scenarios, 100% pass):
- **Scenario 1**: Decomposes mission into topologically sorted subtasks and deduplicates idempotently.
- **Scenario 2**: Rejects decomposition with cyclic dependencies, self-loops, and missing dependencies.
- **Scenario 3**: Rejects decomposition exceeding structural ceilings (`maxChildrenPerParent`, `maxDepth`).
- **Scenario 4**: Rejects decomposition exceeding aggregate resource ceilings (`timeoutMs`).
- **Scenario 5**: Fences subagent capabilities strictly to role contracts and parent permissions (rejects escalation).
- **Scenario 6**: Schedules subtasks durably via TaskRouter preserving topological dependency order.
- **Scenario 7**: Audits child subtask completion against bound verification specifications with zero self-approval.
- **Scenario 8**: Enforces fail-closed mission synthesis gate (blocks synthesis if any child is unverified).
- **Scenario 9**: Cascades cancellation to downstream dependent subtasks when an upstream subtask fails.
- **Scenario 10**: Exposes decompose, hierarchy, and synthesize over REST and preserves strict tenant isolation.

Additional verification:
- Regression suites: 168/168 tests passed across 5 test files (`durable-multi-agent-orchestration.integration.test.ts`, `api-contracts.test.ts`, `fastify-server.test.ts`, `durable-http-server.integration.test.ts`, `task-router.test.ts`).
- TypeScript CI baseline gate: 282 diagnostics (against 287 approved baseline; 0 new diagnostics, 5 resolved).

---

## 7. Consequences

### Positive
- Enables bounded, secure, specialized division of labor across autonomous subagents.
- Eliminates context bloat and hallucinated task completion.
- Guarantees fail-closed verification before any multi-agent mission can complete.
- Preserves full backwards compatibility with existing single-agent task submissions.

### Trade-offs & Limitations
- Subtasks must be planned or decomposed with clear DAG boundaries; circular workflows must be broken into sequential phases.
- Active mission coordinators remain in running/orchestration state until all subtasks synthesize.
- Local rootless container execution requires an OCI-compliant daemon matching host requirements.
