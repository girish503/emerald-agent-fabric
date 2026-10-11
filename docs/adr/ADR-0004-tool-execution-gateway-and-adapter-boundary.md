# ADR-0004: Tool Execution Gateway, Adapter Boundary, and Multi-Step Action Lifecycle

## Status
Approved (Architecture Specification Baseline)

## Date
2026-10-11

## Governing Documents
- [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- [ADR-0001: Master Engineering Constitution](./ADR-0001-master-engineering-constitution.md)
- [ADR-0002: Runtime Kernel, Durable State Machine, Leased Worker Coordination, and Append-Only Event Store](./ADR-0002-runtime-kernel-and-durable-state-machine.md)
- [ADR-0003: Workspace Sandbox Boundary and Typed Tool System Architecture](./ADR-0003-workspace-and-typed-tools.md)
- [Typed Tool System Architecture](../architecture/typed-tools.md)
- [Workspace Sandbox Architecture](../architecture/workspace-sandbox.md)
- [Runtime Architecture](../architecture/runtime.md)
- [Security Architecture](../architecture/security.md)

---

## 1. Context & Problem Statement

In Capability 1 (Tasks 1.1–1.8C), Emerald established a deterministic, crash-recoverable execution runtime governed by cryptographic Mission Contracts, leased worker coordination, and deterministic verification.
In Phase 3 (Tasks 3.1–3.4), Emerald established a hardened Workspace Sandbox featuring lexical path sanitization, canonical filesystem containment, Docker container volume isolation, and sweeper crash recovery.
In Phase 4 / Task 4.1, Emerald established the pure domain contracts, immutable Zod input/output schemas, capability mappings, and error taxonomy for the initial six typed tools:
`read_file`, `write_file`, `search_code`, `git_status`, `git_diff`, and `run_command`.

However, the architecture currently lacks the operational bridge connecting untrusted, model-facing tool invocations to governed physical execution:
1. **Unbridged Ingestion**: A model emits a `ToolRequest` proposing a `toolName` and arbitrary `input`. How does this untrusted payload safely acquire trusted execution context without bypassing Mission Contract governance?
2. **Authorization Boundary**: How does the runtime guarantee that tool capability requirements (`workspace.file.read`, `workspace.file.write`, `workspace.code.search`, `git.read`, `process.execute`) are verified against the authoritative `MissionContract` before any filesystem access or process spawning occurs?
3. **Physical Isolation vs Adapter Boundary**: How do tool adapters interact with `WorkspacePort` and `ExecutionProvider` without creating leaky abstractions, bypassing sandbox confinement, or turning the gateway into a bloated God Object?
4. **Iterative Multi-Step Lifecycle**: Autonomous software-engineering tasks require sequential actions (`read_file` $\rightarrow$ `search_code` $\rightarrow$ `write_file` $\rightarrow$ `run_command`). How do we support fine-grained action lifecycles and attempts without mutating the frozen `Run` state machine or polluting persistent schemas prematurely?

This architecture decision record establishes the system architecture, boundary interfaces, authority pipeline, threat model, and lifecycle semantics for the **Tool Execution Gateway**, **Tool Adapters**, and the **Multi-Step Action Lifecycle**.

---

## 2. Constraints & Non-Negotiable Invariants

All designs in this ADR adhere strictly to the following frozen architectural baselines:

1. **Mission Contract Governance (Task 1.8C) is FROZEN**:
   - The `MissionContract` aggregate, schema, and SQLite persistence layer must remain 100% untouched.
   - Authority flows strictly from the cryptographic Mission Contract bound to the `Run` (`run.contractId`, `run.contractVersion`). Tools declare capability requirements; they never synthesize authority.
2. **Resource Authority Ceilings are FROZEN**:
   - Resource ceilings (`timeoutMs`, `maxAttempts`, `maxOutputBytes`) set in `contract.spec.resourceLimits` are immutable upper bounds.
   - Any requested limit exceeding the contract ceiling **MUST be rejected with zero execution** (`ResourceLimitExceededError`). Silent clamping of unauthorized requests is strictly prohibited.
   - Operational safety limits (e.g. provider limits) may narrow an already-authorized request, but can never authorize an excessive request.
3. **Workspace Sandbox Boundary (Phase 3) is FROZEN**:
   - The dual-boundary protection model (lexical path sanitization in `workspace-path.ts` + canonical realpath containment in `NodeFsWorkspaceAdapter` + container volume isolation in `DockerExecutionProvider`) must be reused, never bypassed or duplicated.
4. **ExecutionProvider API is FROZEN**:
   - The public contract of `ExecutionProvider` (`execute<TInput, TOutput>(request: ExecutionRequest<TInput>): Promise<ExecutionResult<TOutput>>`) remains unchanged.
5. **Zero Production Code Changes in Task 4.2**:
   - This task is strictly architecture, threat modeling, and interface specification. No production runtime code, database migrations, or tool adapter implementations may be committed.

---

## 3. Evaluation of Architectural Alternatives

We evaluated four architectural patterns for mediating between tool requests, governance, adapters, and physical execution:

```text
Alternative A: Direct Adapter Invocation by Gateway
  Gateway ──► Tool Adapter ──► ExecutionProvider / Host

Alternative B: Generic ExecutionRequest Conversion
  Gateway ──► ExecutionRequest ──► ExecutionProvider

Alternative C: Modular Hexagonal Architecture (Selected)
  Gateway ──► Tool Adapter ──► [WorkspacePort | ExecutionProvider]

Alternative D: Universal Orchestration Kernel / Dynamic Plugin Engine
  Universal Kernel ──► Dynamic Plugin Pipeline ──► Distributed Sandbox
```

### Comparative Analysis Matrix

| Evaluation Dimension | Alternative A (Direct Adapter) | Alternative B (Generic ExecutionRequest) | Alternative C (Hexagonal / Selected) | Alternative D (Universal Engine) |
| :--- | :--- | :--- | :--- | :--- |
| **1. Security & Least Privilege** | Low: Adapters need direct access to host/Docker. | Moderate: Flat payload obscures semantic capabilities. | **High**: Narrow adapters receive minimal capability-scoped context. | Moderate: Dynamic plugins introduce broad attack surfaces. |
| **2. Authority & Governance** | Fragile: Adapters might execute before policy checks. | Moderate: Flattens capability checks into generic execution. | **Rigid**: Gateway enforces 11-stage unskippable pipeline before dispatch. | Complex: Policy engine scattered across dynamic plugin hooks. |
| **3. Determinism** | Variable: Depends on individual adapter discipline. | High: Single provider interface, but lossy semantics. | **Absolute**: Pure schemas, canonical hashes, deterministic verification. | Low: Dynamic pipelines introduce nondeterministic side effects. |
| **4. Testability & Mockability** | Moderate: Mocks required at adapter boundary. | Low: Difficult to mock typed tools without mocking raw stdout. | **Maximum**: Fast in-memory unit tests; adapters mockable independently. | Poor: Requires full plugin infrastructure to test a single tool. |
| **5. Observability & Telemetry** | Fragmented: Each adapter logs independently. | Coarse: Only low-level provider telemetry is captured. | **Precise**: Discrete telemetry hooks at every pipeline stage. | Over-engineered: Excessive event overhead and tracing sprawl. |
| **6. Crash Recovery & Resilience** | Poor: Host adapters lack uniform crash semantics. | High: Provider-level recovery, but lacks action context. | **Strong**: Leased worker fencing + idempotency-aware recovery. | Fragile: Distributed orchestration increases partial failure modes. |
| **7. Idempotency & Retry Safety** | Weak: Retries handled inconsistently across adapters. | Weak: Provider cannot discern idempotent vs non-idempotent ops. | **Authoritative**: Gateway & WorkerRuntime govern retries fail-closed. | Complex: Distributed state machines complicate retry ownership. |
| **8. Extensibility** | High, but unprincipled. | Low: Adding tools requires overloading ExecutionRequest. | **High**: Adding tools requires only schema, capability, and adapter. | Excessive: Over-engineered for 6 initial tools. |
| **9. Architectural Coupling** | High: Gateway coupled to adapter implementations. | High: Tool system coupled directly to ExecutionProvider. | **Decoupled**: Hexagonal separation via ports and interfaces. | Decoupled, but massive abstraction cost. |
| **10. Execution Performance** | Fastest for host, unsafe for commands. | Latency penalty: Every tool pays container startup cost. | **Optimal**: Fast contained fs I/O; container isolation for commands. | Slow: Heavy layered dispatch and middleware interceptors. |
| **11. Failure Isolation** | Low: Unhandled adapter exceptions crash worker. | High: Container crashes isolated, but poor error taxonomy. | **High**: Fail-closed taxonomy; provider failures cleanly mapped. | High, but complex fault domains. |
| **12. Implementation Complexity** | Low initially, tech debt later. | Low initially, architectural dead-end. | **Minimal Viable Complexity**: Smallest design satisfying all rules. | Prohibitive: Violates Constitution Section 2 & 3. |

### Rejection Rationale
- **Alternative A was rejected** because allowing the Gateway to invoke adapters that directly interact with unconstrained host APIs bypasses container isolation for high-risk operations (`run_command`), violating Constitution Section 10 and 11.
- **Alternative B was rejected** because converting high-level typed tool operations (e.g. `read_file`, `search_code`) into generic `ExecutionRequest` payloads forces lossy serialization into raw stdout strings, destroys structured error taxonomy, and imposes container startup latency on simple read-only queries.
- **Alternative D was rejected** as speculative over-abstraction. Introducing a dynamic plugin engine or universal execution graph violates Constitution Section 3 (*Minimal Complexity*) and Section 14 (*No Premature Scaling*).

### Selection Verdict
**Alternative C is selected**. The Tool Execution Gateway acts as the trusted orchestrator enforcing governance, capability policies, schemas, and resource ceilings. Typed Tool Adapters encapsulate the specific execution mechanics. Low-risk filesystem operations are delegated to `WorkspacePort`, while high-risk command execution is delegated to `ExecutionProvider`.

---

## 4. Decision: Hexagonal Architecture & Subsystem Boundary Delineation

We formally adopt **Alternative C**. To ensure the Tool Execution Gateway does not degenerate into a bloated God Object, responsibilities are strictly partitioned across hexagonal boundaries:

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                 APPLICATION LAYER                                │
│                                                                                  │
│   WorkerRuntime (Leased Session Orchestrator)                                   │
│    │                                                                             │
│    ├── Owns Run claiming, lease heartbeat, OCC state transitions                │
│    └── Drives multi-step action loop (Action sequence 1..N)                      │
│         │                                                                        │
│         ▼                                                                        │
│   ToolExecutionGateway (Governance & Validation Orchestrator)                   │
│    │                                                                             │
│    ├── 1. Ingests untrusted ToolRequest                                          │
│    ├── 2. Resolves ToolDefinition from ToolRegistryPort                          │
│    ├── 3. Enforces Active MissionContract binding                                │
│    ├── 4. Evaluates Capability Policy via PolicyEvaluator                        │
│    ├── 5. Validates Resource Ceilings (non-clamping fail-closed)                 │
│    ├── 6. Validates Input Schema via Zod                                         │
│    ├── 7. Asserts Lexical Workspace Path Containment                             │
│    ├── 8. Dispatches to ToolAdapter with minimal ToolExecutionContext            │
│    ├── 9. Validates Output Schema & Enforces Output Size Caps                    │
│    └── 10. Normalizes Errors into deterministic ToolError taxonomy               │
│                                                                                  │
└───────────────┬──────────────────────────────────────────────────┬───────────────┘
                │                                                  │
                ▼                                                  ▼
┌───────────────────────────────┐                  ┌───────────────────────────────┐
│         PORTS LAYER           │                  │         DOMAIN LAYER          │
│                               │                  │                               │
│ - ToolRegistryPort            │                  │ - ToolDefinition, ToolName    │
│ - ToolAdapterPort             │                  │ - ToolInput / ToolOutput      │
│ - WorkspacePort               │                  │ - PolicyEvaluator (Domain)    │
│ - ExecutionProvider (Frozen)  │                  │ - MissionContract (Frozen)    │
│ - ClockPort, StateStorePort   │                  │ - Action, Attempt (Domain)    │
└───────────────┬───────────────┘                  └───────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                 ADAPTERS LAYER                                   │
│                                                                                  │
│ 1. LocalFilesystemToolAdapter (read_file, write_file)                            │
│    └── Interacts strictly with WorkspacePort / NodeFsWorkspaceAdapter            │
│                                                                                  │
│ 2. WorkspaceSearchToolAdapter (search_code)                                      │
│    └── Executes regex search confined strictly to workspace root                 │
│                                                                                  │
│ 3. WorkspaceGitToolAdapter (git_status, git_diff)                                │
│    └── Executes read-only git queries inside workspace root                      │
│                                                                                  │
│ 4. SandboxedCommandToolAdapter (run_command)                                     │
│    └── Mandatory delegation to ExecutionProvider (Docker container)              │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Explicit Responsibilities Guard: What the Gateway Does NOT Do
1. **NO direct process execution**: The Gateway never calls `child_process.spawn()` or `execFile()`.
2. **NO direct filesystem I/O**: The Gateway never calls `fs.readFile()` or `fs.writeFile()`.
3. **NO container management**: The Gateway never interacts with Docker daemons or CLI.
4. **NO lease management**: The Gateway does not acquire, renew, or release worker leases (owned by `WorkerRuntime`).
5. **NO database mutation**: The Gateway does not directly execute SQL queries (delegated to application coordinators).

---

## 5. Trust Boundary & Untrusted Request Ingestion Model

The architecture enforces a strict demarcation between untrusted inputs and trusted runtime invariants:

```text
┌──────────────────────────────────────────────┐
│            UNTRUSTED DOMAIN (External)       │
├──────────────────────────────────────────────┤
│ - Model-proposed tool name                   │
│ - Tool input parameters (paths, query, argv) │
│ - Target repository source code & files      │
│ - Subprocess output (stdout, stderr)         │
│ - Git working tree metadata                  │
│ - Network responses                          │
└──────────────────────┬───────────────────────┘
                       │
                       │ ToolRequest { requestId, toolName, input }
                       ▼
════════════════════════════════════════════════
      TRUST BOUNDARY (ToolExecutionGateway)
════════════════════════════════════════════════
                       │
                       │ Context Injection & Boundary Verification
                       ▼
┌──────────────────────────────────────────────┐
│             TRUSTED DOMAIN (Internal)        │
├──────────────────────────────────────────────┤
│ - Run identity (runId, taskId)               │
│ - Authoritative MissionContract binding      │
│ - Worker identity & Lease fencing token      │
│ - Workspace authorization & root path        │
│ - Capability Policy rules                    │
│ - Resource authority ceilings                │
│ - Monotonic clock & deadlines                │
│ - ExecutionProvider security flags           │
└──────────────────────────────────────────────┘
```

### Ingestion Rule: Zero Model Authority
The model produces **untrusted proposals** only. The `ToolRequest` interface carries only:
- `requestId`: Correlation token generated for the turn.
- `toolName`: Proposed tool identifier.
- `input`: Untrusted input object.

The Gateway **never trusts** caller-supplied `runId`, `contractId`, or resource claims. These are injected exclusively from the ambient, authenticated `ToolExecutionContext` held by `WorkerRuntime`.

---

## 6. MissionContract & Capability Authorization Pipeline

The capability authorization pipeline is unskippable and executes entirely in memory before disk or container access:

```text
                   Untrusted ToolRequest
                             │
                             ▼
Stage 1: Resolve Tool Definition
         ToolRegistryPort.getTool(toolName)
         ├── Not Found ──► REJECT (TOOL_NOT_FOUND)
         └── Resolved ToolDefinition
                 │
                 ▼
Stage 2: Verify Bound MissionContract Status
         run.contractId + run.contractVersion
         ├── Status !== "ACTIVE" ──► REJECT (CONTRACT_REVOKED / FORBIDDEN)
         └── Contract is ACTIVE
                 │
                 ▼
Stage 3: Capability Policy Authorization
         toolDef.requiredCapability (e.g. "workspace.file.write")
                 │
         PolicyEvaluator.evaluate(contract.policy, capability)
         ├── DENIED ──► REJECT (CAPABILITY_DENIED / FORBIDDEN)
         └── ALLOWED ──► Proceed to Resource Authorization
```

### Authoritative Contract Invariants
1. **Exact Binding Invariant**: The Gateway verifies the exact `(contractId, version)` bound to the active `Run`. It must **NEVER**:
   - Query for the "latest" contract in the database.
   - Fall back to a default or global contract.
   - Synthesize or mutate a contract dynamically.
2. **Pre-Execution Fail-Closed Invariant**: If capability evaluation fails, execution halts immediately with `CAPABILITY_DENIED`. **Zero tool code, zero filesystem adapters, and zero container providers are invoked.**

---

## 7. Resource Authority & Non-Clamping Enforcement Model

In accordance with frozen Mission Contract governance (ADR-0003), resource enforcement strictly follows the **Governance Rejection Model**:

```text
                       MissionContract Ceiling
                                  ↓
                      Requested Operational Value
                                  ↓
             ┌────────────────────┴────────────────────┐
             ▼                                         ▼
   requested > ceiling                       requested <= ceiling
             ↓                                         ↓
   REJECT (Zero Execution)                          ACCEPT
(ResourceLimitExceededError)                           ↓
                                             Narrower safety limits
                                                may apply:
                                    effective = min(requested, safetyLimit)
```

### Enforcement Rules Across Resource Dimensions:
1. **Execution Timeout (`timeoutMs`)**:
   - `toolInput.timeoutMs > run.timeoutMs` or `> contract.spec.resourceLimits.timeoutMs` $\rightarrow$ **REJECT**.
   - If within authority, `effectiveTimeout = min(toolInput.timeoutMs, providerSafetyTimeout)`.
2. **Payload Size (`maxBytes` / `maxOutputBytes`)**:
   - `toolInput.maxBytes > contract.spec.resourceLimits.maxOutputBytes` $\rightarrow$ **REJECT**.
   - Silent clamping of requested byte sizes above authority is strictly prohibited.
3. **Search Limits (`maxResults`)**:
   - Validated against tool definition resource descriptor (`toolDef.resourceDescriptor.maxMaxResults = 1000`).
   - Requests exceeding maximum bounds trigger `INVALID_TOOL_INPUT`.

---

## 8. Workspace Authorization & Canonical Containment Model

All file, git, and search tools operate under multi-ring containment:

```text
Ring 1: In-Process Lexical Sanitization (Gateway)
  ├── sanitizeWorkspacePath(path, { allowRoot })
  ├── Reject: Absolute paths (/etc/passwd, C:\Windows)
  ├── Reject: Traversal sequences (../, ..\)
  ├── Reject: Null bytes, control chars, Windows reserved stems (CON, PRN, AUX)
  └── Reject: UNC shares (\\server\share)

Ring 2: Canonical Filesystem Realpath Verification (Workspace Adapter)
  ├── NodeFsWorkspaceAdapter resolves realpath
  ├── Asserts: canonicalTargetPath starts with canonicalWorkspaceRoot
  └── Asserts: Symlinks and junctions cannot escape workspace sandbox

Ring 3: Physical Namespace & Mount Confinement (Execution Provider)
  ├── Docker container mounts strictly workspace hostPath to /workspace
  ├── Root filesystem mounted --read-only
  └── Sensitive host paths (/var/run/docker.sock, ~/.ssh, host /) are blocked
```

### Working Directory Injection
For `run_command`, the Gateway validates `cwd` using `WorkspaceDirectoryPathSchema`. The relative directory is re-rooted under the container's `/workspace` mount point. The host path is never exposed to or manipulated by the container.

---

## 9. Tool Adapter Boundary & Interface Design

### 9.1 The `ToolAdapter` Interface
A tool adapter is a pure execution mechanism behind a minimal domain port:

```typescript
export interface ToolExecutionContext {
  readonly runId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly workspace: {
    readonly workspaceId: string;
    readonly hostPath: string;
    readonly containerMountPath?: string;
  };
  readonly resourceLimits: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly abortSignal: AbortSignal;
}

export interface ToolAdapter<TName extends ToolName = ToolName> {
  readonly toolName: TName;
  execute(
    context: ToolExecutionContext,
    input: ToolInputMap[TName]
  ): Promise<ToolOutputMap[TName]>;
}
```

### 9.2 Adapter Grouping & Isolation Mandate

```text
┌───────────────────────────────┬─────────────────────────────┬──────────────────────────┐
│ Tool Name                     │ Assigned Adapter            │ Mandatory Isolation      │
├───────────────────────────────┼─────────────────────────────┼──────────────────────────┤
│ read_file, write_file         │ LocalFilesystemToolAdapter  │ WORKSPACE (via fs port)  │
│ search_code                   │ WorkspaceSearchToolAdapter  │ WORKSPACE (pure search)  │
│ git_status, git_diff          │ WorkspaceGitToolAdapter     │ WORKSPACE (contained git)│
│ run_command                   │ SandboxedCommandToolAdapter │ SANDBOX (Docker provider)│
└───────────────────────────────┴─────────────────────────────┴──────────────────────────┘
```

#### Mandatory Container Isolation for `run_command`
`run_command` requires `SANDBOX` isolation. `SandboxedCommandToolAdapter` **MUST ALWAYS** dispatch to `ExecutionProvider`. It is architecturally prohibited from invoking Node.js `child_process` on the host. If container isolation is unavailable, `run_command` fails closed with `TOOL_PROVIDER_UNAVAILABLE`.

---

## 10. Hierarchical Execution Model & Lifecycle Semantics

To support iterative agent workflows without destabilizing the frozen `Run` aggregate, Emerald structures execution into five distinct hierarchical concepts:

```text
Run (Durable Mission Boundary)
 └── Status: RUNNING (Persistent FSM)
      └── Execution (Worker Leased Session)
           ├── Action 1: read_file (Sequence 1)
           │    └── Attempt 1 (Succeeded)
           ├── Action 2: search_code (Sequence 2)
           │    └── Attempt 1 (Succeeded)
           ├── Action 3: write_file (Sequence 3)
           │    └── Attempt 1 (Succeeded)
           └── Action 4: run_command (Sequence 4)
                ├── Attempt 1 (Timed Out)
                └── Attempt 2 (Succeeded)
```

### 10.1 The Five Execution Abstractions

| Concept | Purpose | Created By | Trust Level | Persistence | Retry Semantics | Identity | Lifecycle |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`ToolRequest`** | Untrusted model proposal for a single tool call. | Model / Agent Reasoning Loop | Untrusted | Not persisted directly; recorded in audit event stream. | None (request payload only). | `requestId` (UUIDv7) | Proposed $\rightarrow$ Authorized / Denied |
| **`Action`** | Logical, sequential step within a Run's plan. | `WorkerRuntime` / Action Controller | Trusted Domain Entity | Persisted in event store (`action.started`, `action.completed`). | May be retried across multiple attempts if transient. | `actionId` (UUIDv7), `runId`, `sequence` ($1..N$) | Proposed $\rightarrow$ Authorized $\rightarrow$ Executing $\rightarrow$ Completed / Failed |
| **`Attempt`** | A single physical execution instance of an Action. | `ToolExecutionGateway` | Trusted Runtime Entity | Recorded in attempt metadata and evidence payloads. | Individual attempts fail; retries spawn Attempt $N+1$. | `attemptId` (`actionId:attemptNumber`) | Started $\rightarrow$ Succeeded / Failed / Timed Out |
| **`ExecutionRequest`** | Low-level physical sandbox execution payload. | `SandboxedCommandToolAdapter` | Internal System Port | Ephemeral provider argument; logged in execution events. | Provider executes once; reports raw outcome. | `runId`, `taskId`, `idempotencyToken` | Dispatched $\rightarrow$ Finished |
| **`ExecutionResult`** | Raw physical outcome from `ExecutionProvider`. | `ExecutionProvider` | Physical Environment | Captured in Attempt evidence. | Immutable result record. | Correlated to `ExecutionRequest` | Completed (Exit code, stdout, stderr) |

### 10.2 Resolution of Critical Architectural Questions

#### Question 1: Should Task 4.2 introduce the Action/Attempt domain model now, or defer it?
**Decision**: Define the pure domain contracts and types for `Action` and `Attempt` now in the architecture specification and domain models. **Defer database schema migrations and SQLite table persistence to Task 4.4.**
*Rationale*: Defining the types now provides crisp boundaries for idempotency, retry ownership, and error mapping without introducing premature schema migrations before the multi-step runtime loop is implemented.

#### Question 2: Should the Tool Execution Gateway own MissionContract authorization, or should a dedicated AuthorizationService be introduced?
**Decision**: The Gateway coordinates authorization by directly invoking the existing `PolicyEvaluator` with the `MissionContract` bound to the active `Run`. **A separate "AuthorizationService" is rejected.**
*Rationale*: Creating a redundant service layer violates Constitution Section 3 (*Minimal Complexity*). `PolicyEvaluator` is already a pure domain engine; the Gateway simply acts as the orchestration point.

#### Question 3: Where should tool execution events be emitted relative to durable state transitions?
**Decision**: Events follow strict crash-consistent causal ordering:
```text
1. action.proposed (Intent recorded)
2. tool.authorized (Policy & ceilings passed)
3. action.started   (Execution fence established)
4. [Physical Execution Occurs]
5. action.completed / action.failed (Terminal action state committed)
6. tool.completed  / tool.failed   (Result returned to caller)
```
*Rationale*: Never emit completion events before physical side effects and state updates are durable. If a crash occurs at step 4, recovery observes `action.started` without `action.completed`, preventing silent ghost updates.

#### Question 4: Which layer owns retry decisions?
**Decision**: **Authoritative retry ownership belongs exclusively to `WorkerRuntime` / Action Controller.**
- `ToolAdapter` and `ExecutionProvider` **MUST NEVER** autonomously retry operations.
- Non-idempotent tools (`write_file`, `run_command`) fail closed immediately upon error.
- Lower layers report deterministic failure categories; the top-level controller decides whether to retry based on contract limits and tool idempotency classification.

#### Question 5: How does the system prevent an LLM from bypassing tool definitions to directly call `ExecutionProvider`?
**Decision**: Architectural port encapsulation:
1. `ExecutionProvider` is an internal port in `src/ports/`, accessible only to trusted runtime adapters.
2. The agent reasoning loop is exposed **only** to `ToolRequest` proposals mediated by `ToolExecutionGateway`.
3. The Gateway validates all requests against the static, immutable `ToolRegistryPort`. Any attempt to call unregistered or arbitrary operations fails closed with `TOOL_NOT_FOUND`.

---

## 11. Failure Semantics, Error Taxonomy & Error Trust Boundary

### 11.1 Error Taxonomy Mapping
The Gateway maps failures deterministically to the nine domain error codes established in Task 4.1:

```text
┌─────────────────────────────────┬──────────────────────┬────────────────────────────────────────────────────────┐
│ Error Code                      │ Classification       │ Originating Subsystem / Trigger Condition              │
├─────────────────────────────────┼──────────────────────┼────────────────────────────────────────────────────────┤
│ TOOL_NOT_FOUND                  │ Provider / Lookup    │ Tool name not present in StaticToolRegistry.           │
│ INVALID_TOOL_INPUT              │ Validation           │ Zod schema validation failed on input payload.         │
│ CAPABILITY_DENIED               │ Authorization        │ PolicyEvaluator denied tool's required capability.     │
│ WORKSPACE_BOUNDARY_VIOLATION    │ Workspace Security   │ Path traversal, absolute path, or symlink escape.      │
│ TOOL_TIMEOUT                    │ Resource Limit       │ Execution exceeded authorized timeout deadline.        │
│ TOOL_OUTPUT_LIMIT_EXCEEDED      │ Resource Limit       │ Output exceeded authorized maxOutputBytes ceiling.     │
│ TOOL_EXECUTION_FAILED           │ Execution Mechanics  │ Non-zero command exit or unhandled adapter exception.  │
│ TOOL_CANCELLED                  │ Cancellation         │ Worker lease revoked or abort signal triggered.        │
│ TOOL_PROVIDER_UNAVAILABLE       │ Provider Failure     │ Docker daemon unreachable or required sandbox missing. │
└─────────────────────────────────┴──────────────────────┴────────────────────────────────────────────────────────┘
```

### 11.2 Error Trust Boundary & Sanitization
Subprocess output and stack traces are untrusted. Before returning errors to the model or persisting events:
1. Host filesystem absolute paths are redacted.
2. Sensitive environment variables (`AWS_*`, `GITHUB_*`, `*_KEY`) are stripped.
3. Errors returned to the model contain structured, actionable messages without leaking internal host metadata.

---

## 12. Crash Consistency, Recovery & Lease Fencing

```text
Worker Crash Scenario Analysis:
┌──────────────────────────────────────┬────────────────────────────────────────────────────────────────────────┐
│ Crash Point                          │ Recovery Behavior & Guarantees                                         │
├──────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Crash after authorization,           │ Lease expires. Sweeper detects expired lease. Run re-queued.           │
│ before adapter dispatch              │ No side effects occurred. Zero orphaned resources.                    │
├──────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Crash during write_file              │ Temporary write file (.tmp) left behind. Sweeper cleans workspace      │
│ or run_command side effect           │ during orphan reclamation. Action marked UNCERTAIN; never auto-retried.│
├──────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Crash after side effect,             │ Workspace contains mutations. Action not marked completed.             │
│ before result persistence            │ Run fails closed or restarts from clean workspace snapshot.            │
└──────────────────────────────────────┴────────────────────────────────────────────────────────────────────────┘
```

### Stale Worker Lease Fencing
All state mutations and workspace cleanup calls require verification of the worker's active fencing token (`workerId` + `leaseId`). If a worker experiences a GC pause or network partition and loses its lease, any subsequent write attempt is rejected with `LeaseLostError`, preventing zombie workers from corrupting state.

### Honest Revocation Semantics
If a MissionContract transitions to `REVOKED` while an action is executing:
1. `WorkerRuntime` detects revocation on the next synchronous boundary.
2. In-flight container execution is aborted via best-effort `docker kill`.
3. **`NO NEXT ACTION`** is permitted.
4. The workspace sandbox is unconditionally unlinked via `disposeWorkspace()`.
5. The `Run` transitions to terminal `FAILED` with error code `CONTRACT_REVOKED`.

---

## 13. Canonical Evidence & Deterministic Verification Integration

Tool execution produces structured, verifiable evidence for post-execution auditing:

```text
ToolResult ──► Redact Sensitive Keys ──► Sort Keys Deterministically ──► Compute SHA-256 Digest
                                                                                │
                                                                                ▼
                                                                        Evidence Payload
                                                                                │
                                                                                ▼
                                                                     DeterministicVerifier
```

1. **Evidence Separation**: High-frequency read queries emit lightweight audit events (`tool.invoked`). Mutating actions (`write_file`, `run_command`) produce formal `Evidence` payloads committed with the action outcome.
2. **Deterministic Verification**: Output hashes (`contentHash`, `diffHash`, `commandHash`) recorded in tool outputs allow `DeterministicVerifier` to corroborate execution integrity without re-running non-deterministic LLMs.

---

## 14. Comprehensive Security Threat Model (24 Threat Vectors)

In accordance with Constitution Section 12 (*Security*), the architecture evaluates 24 attack vectors across the complete tool boundary:

| ID | Threat Vector | Targeted Asset | Attacker / Control | Attack Mechanism | Existing Defense (Phase 3 / 1.8C) | Task 4.2 Gateway & Adapter Defense | Residual Risk |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **T01** | Malicious LLM Tool Request | Gateway Integrity | Compromised LLM / Prompt Injection | Emitting invalid tool names or malformed arguments. | None. | Static registry lookup + strict Zod schema validation (`.strict()`). | Model may emit syntactically valid but logically erroneous code. |
| **T02** | Relative Path Traversal | Host Filesystem | Malicious Prompt / Input | Input containing `../../etc/passwd`. | Lexical sanitizer in `workspace-path.ts`. | Pre-adapter schema assertion via `WorkspaceRelativePathSchema`. | Zero. Traversal fails closed before disk access. |
| **T03** | Symlink / Junction Escape | Host Filesystem | Malicious Repo / Symlink | Reading/writing through symlink pointing outside root. | Realpath canonical check in `NodeFsWorkspaceAdapter`. | Pre-write canonical containment check before every adapter operation. | Low. TOCTOU mitigated by container namespace mounting. |
| **T04** | Malicious Repository Content | Worker Runtime | Malicious Cloned Repo | Repo containing dangerous config files or hidden scripts. | Cloned at immutable SHA in isolated workspace. | Read-only baseline commit tracking; Git tools execute in sandbox. | Code inside repo may contain subtle logic bugs. |
| **T05** | Malicious File Contents | Gateway Memory | Malicious Input | Embedding NUL bytes (`\0`) or control characters in filenames. | Lexical path sanitizer rejects NUL bytes. | Zod schema validation rejects control characters in file paths. | Zero. Lexically invalid names rejected immediately. |
| **T06** | Shell Injection via Arguments | Container / Host | Malicious Prompt / Input | Chaining commands via `; rm -rf /` or `\| curl`. | Docker container drops capabilities. | `run_command` enforces discrete `argv: string[]` tokens; zero shell wrapping. | Executable itself may have internal parameter vulnerabilities. |
| **T07** | Command Substitution | Container Shell | Malicious Prompt / Input | Passing backticks (`` `cmd` ``) or `$()` in arguments. | Non-root execution in container. | Command executed directly via argv vector without shell evaluation. | Zero. No shell interpreter is invoked. |
| **T08** | Environment Variable Leakage | Host Secrets | Subprocess / Container | Process dumping environment to inspect host credentials. | Container env whitelist. | Strict clean environment; host `process.env` stripped by adapter. | Low. Secrets explicitly placed in workspace files remain visible. |
| **T09** | Secret Leakage in Evidence | Audit Event Store | Malicious Output | Tool output containing API tokens or private keys. | Canonical hash key redaction. | Output redactor sanitizes known secret patterns before persistence. | Novel or unstructured secrets may escape pattern matchers. |
| **T10** | Docker Socket Exposure | Host Root Daemon | Malicious Container | Attacker attempting to access `/var/run/docker.sock`. | Socket strictly forbidden in container mounts. | ExecutionProvider config validation asserts zero socket mounts. | Zero. Socket is never mounted. |
| **T11** | Host Filesystem Exposure | Host OS Root | Malicious Container | Container breakout via host mount. | Container rootfs `--read-only`; workspace is isolated subvolume. | Adapter only passes assigned `hostPath` to provider. | Low. Relies on Linux kernel cgroup/namespace integrity. |
| **T12** | Network Exfiltration Escape | Private Networks | Malicious Script | In-container script connecting out to download malware. | `--network=none` by default. | Adapter asserts network isolation unless explicitly authorized. | Zero network access when `--network=none` is enforced. |
| **T13** | Output Flooding (Stdout Bomb) | Gateway Memory | Malicious Script | Emitting gigabytes of random data on stdout. | Provider stream byte counter. | Streaming truncation at `maxOutputBytes` with `truncated: true`. | Bounded memory usage up to authorized ceiling (e.g. 1MB). |
| **T14** | ReDoS / Search CPU Exhaustion | Worker CPU | Malicious Regex | Catastrophic backtracking in `search_code`. | None. | Hard timeout (5000ms) + bounded search results (max 1000). | CPU pegged for up to 5 seconds before timeout abort. |
| **T15** | Fork Bomb / Process Storm | Host / Container | Malicious Script | Fork bomb (`:(){ :\|:& };:`) exhausting system processes. | `--pids-limit=64` in container. | Container cgroup pid limits prevent host process starvation. | Container process table fills; container killed by runtime. |
| **T16** | Stale Worker Writing Workspace | Workspace State | Network Partition / GC | Fenced worker writing to reclaimed workspace. | Lease fencing token verification. | Gateway asserts `workerId + leaseId` before initiating any mutation. | Zero. Stale writes rejected by state store OCC. |
| **T17** | Revoked Contract Bypass | System Governance | Revoked Authority | Executing tools under revoked MissionContract. | Pre-dispatch status check. | Gateway asserts `contract.status === "ACTIVE"` prior to each action. | Zero. Pre-action check halts execution immediately. |
| **T18** | Capability Policy Escalation | System Governance | Unauthorized Tool | Tool requesting capability not granted in contract. | PolicyEvaluator engine. | Gateway evaluates capability before adapter dispatch; fails closed. | Zero. Unauthorized capabilities blocked with FORBIDDEN. |
| **T19** | Duplicate Side Effects (Retries) | Target Repository | Transient Network Glitch | Blindly retrying `write_file` or `run_command`. | None. | Gateway classifies tools; non-idempotent tools never auto-retried. | User/Agent must explicitly formulate recovery action. |
| **T20** | Crash Consistency Gap After Write| Workspace State | Worker Crash | File written to disk but crash prevents event commit. | SQLite WAL mode. | Atomic write via temp file + rename; recovery detects incomplete action. | Disk has changes; recovery marks run FAILED for safety. |
| **T21** | Adapter Impersonation | Gateway Boundary | Rogue Code | Untrusted component claiming to be a valid adapter. | None. | Adapters registered statically behind typed `ToolAdapterPort`. | Zero. Dynamic registration is prohibited. |
| **T22** | Forged Tool Identity | Audit Trail | Malicious LLM | Submitting unexpected tool names to bypass logging. | Static registry lookup. | Gateway rejects unknown tools with `TOOL_NOT_FOUND`. | Zero. All tool names validated against enum. |
| **T23** | Malformed Tool Output | Gateway Parser | Buggy / Compromised Adapter | Adapter returning non-conforming output payload. | None. | Gateway validates adapter return value against Zod output schema. | Fails closed with `TOOL_EXECUTION_FAILED`. |
| **T24** | Prompt Injection via Tool Output | Model Reasoning | Malicious Source File | File containing instructions to hijack future LLM turns. | None. | Output labeled as untrusted observation data; strict delimiting. | LLM reasoning vulnerability; mitigated at prompt harness layer. |

---

## 15. Observability & Latency Decomposition Architecture

To satisfy Constitution Section 18 (*Latency Model*), the Tool Execution Gateway exposes precise telemetry hooks across the 11-stage pipeline:

```text
tool_action_latency_ms
  ├── stage1_registry_lookup_ms     (ToolDefinition resolution time)
  ├── stage2_contract_check_ms      (MissionContract status verification time)
  ├── stage3_policy_eval_ms         (PolicyEvaluator capability check time)
  ├── stage4_resource_auth_ms       (Ceiling & limit validation time)
  ├── stage5_schema_validation_ms   (Zod input schema parsing time)
  ├── stage6_path_sanitization_ms   (Lexical path containment check time)
  ├── stage7_adapter_dispatch_ms    (Adapter setup & parameter preparation time)
  ├── stage8_physical_execution_ms  (Underlying fs operation or container runtime)
  ├── stage9_output_validation_ms   (Zod output schema parsing & size check time)
  ├── stage10_evidence_capture_ms   (Hashing, key sorting, & digest creation time)
  └── stage11_event_commit_ms       (Audit event append & OCC commit time)
```

No heuristic optimization may be introduced in Reflex (Phase 11) without attributing latency changes to one of these measured telemetry intervals.

---

## 16. Test Strategy & Verification Architecture

Task 4.2 establishes the testing architecture for subsequent implementation increments:

### 16.1 Unit Tests (Pure Domain & Gateway Logic)
- **Tool Registry**: Verify static catalog lookup, duplicate detection, and unknown tool rejection.
- **Capability Policy**: Verify fail-closed rejection when capabilities are omitted from contract.
- **Resource Ceilings**: Verify strict rejection (no silent clamping) when requested resource exceeds contract ceiling.
- **Schema Validation**: Verify strict rejection of unknown keys, invalid types, and empty command strings.
- **Lexical Sanitization**: Verify rejection of traversal (`..`), absolute paths, NUL bytes, and Windows reserved stems.

### 16.2 Integration Tests (Adapters & Workspace Port)
- **LocalFilesystemToolAdapter**: Test `read_file` and `write_file` against `NodeFsWorkspaceAdapter` in temporary directories.
- **WorkspaceSearchToolAdapter**: Test literal and regex code searches within real directory trees.
- **WorkspaceGitToolAdapter**: Test `git_status` and `git_diff` against initialized local git repositories.
- **SandboxedCommandToolAdapter**: Test command execution via `ExecutionProvider` mock and real Docker containers.

### 16.3 Security Tests (Adversarial Probes)
- **Traversal Probes**: Attempt relative and symlink escapes across all file tools.
- **Shell Injection Probes**: Pass semicolons, pipes, backticks, and subshells to `run_command`.
- **Revocation Probes**: Revoke contract mid-sequence; assert subsequent actions fail immediately.
- **Lease Theft Probes**: Invalidate worker lease token; assert adapter mutations fail closed.

### 16.4 Failure Injection Tests
- **Provider Unavailable**: Simulate missing Docker daemon; assert `TOOL_PROVIDER_UNAVAILABLE`.
- **Timeout Abortion**: Simulate hung process; assert `TOOL_TIMEOUT` and process termination.
- **Output Flooding**: Emit stdout payloads > 1MB; assert truncation flag and bounded memory.

---

## 17. Implementation Sequencing & Incremental Roadmap

To maintain engineering discipline and zero regression, Phase 4 implementation is sequenced into five granular, independently verifiable sub-tasks:

```text
Task 4.2-A: Tool Execution Gateway Core & Boundary Interfaces
  ├── Define ToolAdapterPort and ToolExecutionContext interfaces
  ├── Implement ToolExecutionGateway with 11-stage pipeline orchestration
  └── Unit tests with mock adapters (100% in-memory)

Task 4.2-B: Read-Only Workspace Tool Adapters
  ├── Implement LocalFilesystemToolAdapter (read_file)
  ├── Implement WorkspaceSearchToolAdapter (search_code)
  └── Integration tests against NodeFsWorkspaceAdapter

Task 4.2-C: Git & Mutating Workspace Tool Adapters
  ├── Implement LocalFilesystemToolAdapter (write_file) with atomic rename
  ├── Implement WorkspaceGitToolAdapter (git_status, git_diff)
  └── Integration tests with synthetic Git repositories

Task 4.2-D: Sandboxed Command Tool Adapter & Docker Provider Binding
  ├── Implement SandboxedCommandToolAdapter (run_command)
  ├── Bind DockerExecutionProvider mount configuration (/workspace)
  └── Integration tests verifying argv tokenization and container isolation

Task 4.2-E: Multi-Step Action Loop & WorkerRuntime Integration
  ├── Introduce Action / Attempt runtime coordination in WorkerRuntime
  ├── Implement sequential tool invocation under worker lease
  └── End-to-end integration tests (Run -> Actions 1..N -> VerificationSpec)
```

---

## 18. Consequences & Trade-offs

### Positive
- **Guaranteed Governance Integrity**: Mission Contracts and capability policies remain strictly authoritative; models can never manufacture authority.
- **Zero Silent Clamping**: Resource ceilings reject excessive requests transparently, preserving constitutional predictability.
- **Robust Defense-in-Depth**: Dual-boundary filesystem protection + container cgroups eliminate escape vectors.
- **Clean Hexagonal Decoupling**: Gateway does not know about Docker or Git CLI; adapters do not know about Mission Contracts or database tables.
- **High Testability**: 100% of gateway logic testable in-memory without Docker daemons or host filesystem side effects.

### Negative & Trade-offs
- **Layered Pipeline Overhead**: Passing through 11 distinct pipeline stages adds ~2–5ms of validation latency per tool invocation (negligible compared to container startup or model inference).
- **Rigid Adapter Contracts**: Every new tool requires explicit schema, capability mapping, and adapter implementation rather than arbitrary shell execution.

---

## 19. Revisit Conditions

This architecture decision record must be formally reviewed and updated via a subsequent ADR if:
1. Multi-tenant cloud deployments require hardware-virtualized microVMs (e.g. Firecracker) replacing local Docker container sandboxes.
2. Interactive human-in-the-loop approval gates require pausing and resuming in-flight Action attempts across asynchronous worker sessions.
3. Streaming tool output protocols (e.g. live stdout streaming over WebSockets) require real-time chunked evidence generation.
