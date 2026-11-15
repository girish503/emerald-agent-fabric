# PHASE 1 — SHARED CONTRACTS & INTERFACES SPECIFICATION
**Emerald Agent Fabric — Antigravity Build**  
**Document**: `PHASE-1-INTERFACES.md`  
**Status**: DRAFT FOR FOUNDER APPROVAL (Read-Only Interface Freeze)  
**Date**: 2026-11-13  
**Single Schema Owner**: `src/adapters/persistence/schema.ts`

---

## 1. Architectural Guardrails & File Ownership Map

To eliminate race conditions, merge conflicts, and schema drift across execution tracks, file ownership is frozen and partitioned into explicit boundaries. **`src/adapters/persistence/schema.ts` is the sole authoritative owner of SQLite table definitions and DDL migrations.** No other file may define or execute DDL `CREATE TABLE` or `ALTER TABLE` statements.

### File Ownership Matrix

| Subsystem / Track | Primary Files Owned | Description & Boundaries |
| :--- | :--- | :--- |
| **Schema & Persistence Authority** | `src/adapters/persistence/schema.ts`<br>`src/adapters/persistence/sqlite-state-store.ts`<br>`src/adapters/persistence/index.ts` | **Single Migration Owner**. Defines all SQLite tables, DDL migrations, WAL pragmas, and transactional state access. |
| **Track A: Durable Worker Runtime** | `src/application/worker-runtime.ts`<br>`src/application/agent-step-controller.ts`<br>`src/application/tool-execution-gateway.ts`<br>`src/control-plane/approval-control.ts`<br>`src/application/scoped-context-memory.ts`<br>`src/application/governed-tool-connector.ts`<br>`src/application/bounded-repair-loop.ts` | Executes attempt lifecycle, enforces tenant quiescence, dispatches governed connectors, manages scoped memory, integrates bounded repair, and checks human approvals before destructive tools. |
| **Track B: Orchestration & DAG** | `src/application/task-router.ts`<br>`src/application/run-coordinator.ts`<br>`src/application/router-host.ts`<br>`src/domain/multi-agent-plan.ts` | Manages multi-parent DAG task dependencies, in-flight run caps, admission queue, cycle detection, and dependency-aware `claimRun` dispatching. |
| **Track B: Transport, SSE & API** | `src/transport/http/server.ts`<br>`src/transport/http/api-contracts.ts`<br>`src/cli/emerald-cli.ts` | Fastify REST endpoints, OpenAPI Zod contracts, SSE event streaming replay, auth principal validation, and CLI commands. |
| **Verification & Evidence** | `src/domain/verification.ts`<br>`src/application/clean-room-verifier.ts`<br>`src/domain/evidence.ts`<br>`src/application/verification-operation-registry.ts` | Fail-closed sovereign verification, dual-gate (fail-to-pass / pass-to-pass), cryptographic SHA-256 evidence sealing. Pure and deterministic. |
| **Observability Infrastructure** | `src/ports/observability.port.ts`<br>`src/infrastructure/monitoring/otel-observability.ts`<br>`src/application/observability-instrumentation.ts` | Vendor-neutral OpenTelemetry distributed tracing, Prometheus metrics registry, redaction firewall, and telemetry export. |

---

## 2. Multi-Parent DAG Schema & Migration (`task_dependencies`)

**Owner**: `src/adapters/persistence/schema.ts`  
**Purpose**: Replaces legacy single-parent task pointers with an immutable, durable multi-parent directed acyclic graph (DAG). A child task cannot transition from `QUEUED` to `RUNNING` until **all** parent tasks are in `COMPLETED` status.

### SQLite Schema Definition
```sql
CREATE TABLE IF NOT EXISTS task_dependencies (
    child_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    parent_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (child_task_id, parent_task_id),
    CHECK (child_task_id <> parent_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_parent 
    ON task_dependencies(parent_task_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_child 
    ON task_dependencies(child_task_id, ordinal);
```

### Additive Migration Logic
```sql
-- Idempotent forward-migration from legacy single-parent task_relations table
INSERT OR IGNORE INTO task_dependencies (child_task_id, parent_task_id, ordinal, created_at)
SELECT child_task_id, parent_task_id, ordinal, created_at
FROM task_relations
WHERE child_task_id <> parent_task_id;
```

### TypeScript Data Access Contract (`TaskRouterStorePort`)
```typescript
export interface TaskDependencyRecord {
  readonly childTaskId: string;
  readonly parentTaskId: string;
  readonly ordinal: number;
  readonly createdAt: string;
}

export interface TaskRouterStorePort {
  recordDependencies(dependencies: readonly TaskDependencyRecord[]): Promise<void>;
  getParentTaskIds(childTaskId: string): Promise<readonly string[]>;
  getChildTaskIds(parentTaskId: string): Promise<readonly string[]>;
  areAllParentsCompleted(childTaskId: string): Promise<boolean>;
  detectCycle(candidateChildId: string, candidateParentId: string): Promise<boolean>;
}
```

---

## 3. Durable Human Approval Store Schema (`approval_requests`)

**Owner**: `src/adapters/persistence/schema.ts`  
**Purpose**: Replaces transient in-memory approval maps with durable SQLite records. Suspends execution when dangerous or cost-incurring operations are proposed, safely fencing worker leases in `WAITING_APPROVAL` lifecycle state.

### SQLite Schema Definition
```sql
CREATE TABLE IF NOT EXISTS approval_requests (
    approval_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL DEFAULT '',
    tenant_id TEXT NOT NULL DEFAULT 'default-tenant',
    contract_hash TEXT NOT NULL DEFAULT '',
    action_id TEXT,
    operation TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    parameters_hash TEXT NOT NULL CHECK(length(parameters_hash) = 64),
    risk_level TEXT NOT NULL CHECK(risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    justification TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'CONSUMED', 'EXPIRED')),
    single_use INTEGER NOT NULL DEFAULT 1 CHECK(single_use IN (0, 1)),
    requested_at TEXT NOT NULL,
    expires_at TEXT,
    decided_at TEXT,
    consumed_at TEXT,
    consumed_by_run_id TEXT,
    approver TEXT,
    decision_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_run_op 
    ON approval_requests(run_id, operation, status);

CREATE INDEX IF NOT EXISTS idx_approvals_status 
    ON approval_requests(status);

CREATE INDEX IF NOT EXISTS idx_approvals_tenant_task 
    ON approval_requests(tenant_id, task_id);
```

### Approval Governance Invariants
1. **Self-Approval Refusal**: An autonomous agent cannot approve its own requests. Approvals require external operator identity (`approver != null`).
2. **Single-Use Consumption**: Once an approval is consumed to execute an action (`status = 'CONSUMED'`), it cannot be reused.
3. **Lease-Fenced Transitions**: When a run enters `WAITING_APPROVAL`, its worker lease is gracefully surrendered or paused so stale workers cannot mutate execution state.
4. **Parameter Hash Binding**: The approval binds the exact SHA-256 hash of canonical action parameters. Any parameter tampering invalidates the approval token.

---

## 4. Scoped Context Memory Schema & Truth Firewall (`scoped_memories`)

**Owner**: `src/adapters/persistence/schema.ts`  
**Purpose**: Enforces deterministic, role-isolated, verifiable context construction for multi-agent workflows. Prevents prompt injection, hallucinated memory contamination, and untrusted observation promotion.

### SQLite Schema Definition
```sql
CREATE TABLE IF NOT EXISTS scoped_memories (
    memory_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL CHECK(length(trim(tenant_id)) > 0),
    task_id TEXT NOT NULL CHECK(length(trim(task_id)) > 0),
    run_id TEXT CHECK(run_id IS NULL OR length(trim(run_id)) > 0),
    agent_id TEXT CHECK(agent_id IS NULL OR length(trim(agent_id)) > 0),
    scope TEXT NOT NULL CHECK(scope IN (
        'CURRENT_TASK_CONTEXT',
        'DURABLE_TASK_HISTORY',
        'PROJECT_KNOWLEDGE',
        'AGENT_WORKING_CONTEXT',
        'VERIFIED_EVIDENCE',
        'UNTRUSTED_OBSERVATION'
    )),
    source TEXT NOT NULL CHECK(length(trim(source)) > 0),
    is_model_generated INTEGER NOT NULL CHECK(is_model_generated IN (0, 1)),
    is_independently_verified INTEGER NOT NULL CHECK(is_independently_verified IN (0, 1)),
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
    estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens >= 0),
    metadata_json TEXT,
    idempotency_key TEXT CHECK(idempotency_key IS NULL OR length(trim(idempotency_key)) > 0),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    -- Database-Enforced Truth Firewall Invariants:
    CHECK(NOT (is_model_generated = 1 AND is_independently_verified = 1)),
    CHECK(NOT (is_model_generated = 1 AND scope = 'VERIFIED_EVIDENCE'))
);

CREATE INDEX IF NOT EXISTS idx_scoped_memories_tenant_task
    ON scoped_memories(tenant_id, task_id, scope, created_at, memory_id);

CREATE INDEX IF NOT EXISTS idx_scoped_memories_run
    ON scoped_memories(tenant_id, task_id, run_id) WHERE run_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scoped_memories_idem
    ON scoped_memories(tenant_id, task_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
```

### Truth Firewall Invariants
1. **Model Output Untrusted**: Model-generated output (`is_model_generated = 1`) can **never** be inserted as `VERIFIED_EVIDENCE` or flagged as `is_independently_verified = 1` by an agent.
2. **Promotion via Sovereign Verifier Only**: Only the independent verifier (or human operator) can promote information into `VERIFIED_EVIDENCE`.
3. **Idempotent Storage**: Prevents context bloating across repeated retry loops using `(tenant_id, task_id, idempotency_key)`.

---

## 5. Governed Tool Connector Interface

**Owner**: `src/application/governed-tool-connector.ts`  
**Purpose**: Standardizes typed, sandboxed tool dispatching with capability authorization, bounded outputs, timeouts, and cooperative cancellation.

### TypeScript Contract
```typescript
import { z } from "zod";

export interface ToolConnectorContext {
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly authorizedCapabilities: readonly string[];
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly abortSignal?: AbortSignal;
  readonly idempotencyKey?: string;
}

export interface ToolConnectorExecutionResult<T = unknown> {
  readonly success: boolean;
  readonly output?: T;
  readonly error?: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly bytesEmitted: number;
  readonly executionHash: string;
  readonly cached?: boolean;
}

export interface GovernedToolConnector<TInput = unknown, TOutput = unknown> {
  readonly connectorId: string;
  readonly name: string;
  readonly description: string;
  readonly requiredCapability: string;
  readonly isIdempotent: boolean;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;

  execute(
    input: TInput,
    context: ToolConnectorContext
  ): Promise<ToolConnectorExecutionResult<TOutput>>;
}
```

### Error Taxonomy
- `ConnectorAuthorizationError`: Thrown when `authorizedCapabilities` does not include `requiredCapability`.
- `ConnectorTimeoutError`: Thrown when execution exceeds `timeoutMs`.
- `ConnectorCancelledError`: Thrown when `abortSignal` is triggered.
- `ConnectorSchemaValidationError`: Thrown when input payload fails Zod validation.

---

## 6. Bounded Autonomous Repair Interface

**Owner**: `src/application/bounded-repair-loop.ts`  
**Purpose**: Enforces bounded failure diagnosis and repair. Prevents unbounded loops, patch thrashing, and self-approval.

### TypeScript Contract
```typescript
export type RepairStage =
  | "OBSERVE"
  | "PLAN"
  | "ACT"
  | "CAPTURE_FEEDBACK"
  | "DIAGNOSE"
  | "REPAIR"
  | "RETEST"
  | "INDEPENDENTLY_VERIFY"
  | "TERMINAL_SUCCESS"
  | "TERMINAL_FAILED"
  | "TERMINAL_EXHAUSTED";

export type DiagnosticCategory =
  | "SYNTAX_ERROR"
  | "TEST_ASSERTION_FAILURE"
  | "RUNTIME_EXCEPTION"
  | "TIMEOUT_EXHAUSTION"
  | "POLICY_DENIAL"
  | "UNKNOWN_ERROR";

export interface RepairLimits {
  readonly maxRepairIterations: number;   // default: 3
  readonly maxCumulativeTimeMs: number;   // default: 180,000 ms (3 min)
  readonly maxCumulativeActions: number;  // default: 15 actions
}

export interface RepairCycleState {
  readonly taskId: string;
  readonly runId: string;
  currentStage: RepairStage;
  iterationCount: number;
  cumulativeActions: number;
  cumulativeTimeMs: number;
  lastDiagnosis?: {
    category: DiagnosticCategory;
    summary: string;
    targetFile?: string;
  };
  previousPatchHashes: Set<string>;
  terminalReason?: string;
}

export interface BoundedRepairLoop {
  initCycle(taskId: string, runId: string): RepairCycleState;
  diagnoseFeedback(state: RepairCycleState, testStderr: string, testStdout: string, exitCode: number): DiagnosticCategory;
  shouldContinueRepair(state: RepairCycleState): { canContinue: boolean; reason?: string };
  recordPatchHash(state: RepairCycleState, patchDiffText: string): { isStagnant: boolean; patchHash: string };
}
```

---

## 7. Fail-Closed Verification Spec Shape

**Owner**: `src/domain/verification.ts`  
**Purpose**: Sovereign verification boundary. Verification authority belongs strictly to deterministic assertions, never to agent claims. Missing or empty specs fail closed.

### TypeScript Contract
```typescript
export type VerificationRuleKind =
  | "EXACT_OUTPUT_MATCH"
  | "OUTPUT_HASH_MATCH"
  | "EXIT_CODE_ZERO"
  | "CLEAN_ROOM_DUAL_GATE";

export interface VerificationSpec {
  readonly specId: string;
  readonly ruleKind: VerificationRuleKind;
  readonly expectedValue?: unknown;
  readonly expectedHash?: string;
}

export interface CleanRoomVerificationSpec {
  readonly specId: string;
  readonly baselineCommitSha: string;
  readonly failToPass: {
    readonly testCommand: readonly string[];
    readonly expectedBaselineExitCode: number;
    readonly expectedPatchedExitCode: 0;
    readonly minTestCount: number;
    readonly suiteRanRegex: string;
  };
  readonly passToPass: {
    readonly testCommand: readonly string[];
    readonly expectedBaselineExitCode: 0;
    readonly expectedPatchedExitCode: 0;
    readonly minTestCount: number;
    readonly suiteRanRegex: string;
  };
  readonly allowedPathPatterns: readonly string[];
  readonly timeoutMs: number;
}

export interface VerificationResult {
  readonly status: "VERIFIED" | "FAILED";
  readonly verifierId: string;
  readonly specId: string;
  readonly evidenceIds: readonly string[];
  readonly reasonCode?: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly verifiedAt: string;
}
```

### Fail-Closed Enforcement
- In `durable-submission.ts` and `WorkerRuntime`: If `verificationSpecs` is empty (`[]`), the run **must NOT complete as success**. A run with no verification specs produces verdict `FAILED` with reason `MISSING_VERIFICATION_SPEC`.

---

## 8. SSE Streaming & Event Envelopes

**Owner**: `src/transport/http/api-contracts.ts`  
**Purpose**: Replays ordered execution lifecycle events over HTTP SSE streams (`/api/v1/runs/:runId/stream`) with gapless sequence guarantees.

### TypeScript SSE Envelope Schema
```typescript
import { z } from "zod";

export const SseEventEnvelopeSchema = z.object({
  id: z.string().min(1),
  event: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  schemaVersion: z.number().int().positive(),
  producer: z.string().min(1),
  data: z.unknown(),
});

export type SseEventEnvelope = z.infer<typeof SseEventEnvelopeSchema>;
```

### Terminal & Control Event Types
- **Terminal Lifecycle Events** (closes stream normally):
  `"run.completed"` | `"run.failed"` | `"run.cancelled"` | `"run.timed_out"`
- **Transport Control Events** (transport signals, no sequence increment):
  `"stream.overflow"` | `"stream.error"`

---

## 9. HTTP REST API Request & Response Shapes

**Owner**: `src/transport/http/api-contracts.ts`  
**Purpose**: REST contracts for goal submission, DAG inspection, and human approval response.

### 1. Create Task Request & Response (`POST /api/v1/tasks` or `/api/v1/runs`)
```typescript
export const CreateTaskRequestSchema = z.object({
  title: z.string().min(1).max(256),
  prompt: z.string().min(1).max(65536),
  repoPath: z.string().max(1024).optional(),
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  executionMode: z.enum(["sandboxed", "constrained_host"]).default("sandboxed"),
  modelConfig: z.object({
    provider: z.string().default("ollama"),
    modelName: z.string(),
    temperature: z.number().min(0).max(2).default(0),
    contextWindow: z.number().default(8192),
  }),
  resourceLimits: z.object({
    timeoutSeconds: z.number().default(1800),
    maxSteps: z.number().default(50),
    maxOutputBytes: z.number().default(1024 * 1024),
  }).default({}),
  verificationSpecs: z.array(z.object({
    specId: z.string().optional(),
    ruleKind: z.enum(["EXIT_CODE_ZERO", "EXACT_OUTPUT_MATCH", "OUTPUT_HASH_MATCH"]).default("EXIT_CODE_ZERO"),
    command: z.string().optional(),
    argv: z.array(z.string()).optional(),
    expectedExitCode: z.number().default(0),
    timeoutMs: z.number().default(30000),
  })).min(1, "At least one verification spec is required (fail-closed)"),
  idempotencyKey: z.string().optional(),
}).strict();
```

### 2. Approval Decision Request & Response (`POST /api/v1/approvals/:approvalId/decide`)
```typescript
export const ApprovalDecisionRequestSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().min(1).max(512).optional(),
}).strict();

export const ApprovalDecisionResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    approvalId: z.string(),
    status: z.enum(["APPROVED", "REJECTED"]),
    runStatus: z.string(),
    resumed: z.boolean(),
  }),
});
```

### 3. Task DAG Response (`GET /api/v1/tasks/:taskId/dag`)
```typescript
export const TaskDagNodeSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  status: z.string(),
  parentTaskIds: z.array(z.string()),
  childTaskIds: z.array(z.string()),
});

export const TaskDagResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    rootTaskId: z.string(),
    nodes: z.array(TaskDagNodeSchema),
  }),
});
```

---

## 10. Phase 1 Gate Verification & Stop Rule

1. **No Code Implementation**: No Phase 2 functional logic, adapters, or wiring were authored during this phase.
2. **Schema Authority Locked**: All agents and engineers must respect `src/adapters/persistence/schema.ts` as the sole migration owner.
3. **Founder Review Point**: Awaiting founder/user review and sign-off on `PHASE-1-INTERFACES.md`.
