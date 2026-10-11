# Emerald Agent Fabric: Typed Tool System & Multi-Step Execution Architecture

## Document Information
- **Status**: Architecture Specification — Phase 4 Baseline
- **Governing Constitution**: [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- **Layer**: Architecture Specification
- **Related ADR**: [ADR-0003: Workspace Sandbox Boundary and Typed Tool System Architecture](../adr/ADR-0003-workspace-and-typed-tools.md)
- **Upstream Dependencies**: [Workspace Sandbox Architecture](./workspace-sandbox.md), [Runtime Architecture](./runtime.md), [Security Architecture](./security.md)

---

## 1. Context & Background

In Capability 1 (Tasks 1.1–1.8C), Emerald established a deterministic, crash-recoverable execution substrate. Operations are currently restricted to four toy mathematical primitives (`execution.echo`, `execution.sum`, `execution.slow`, `execution.fail`) dispatched as a single monolithic execution per `Run`.

Real software engineering agents cannot solve GitHub issues or write code with synthetic echo/sum scripts. To operate on real repositories, the fabric requires a **Typed Tool System**. 

In adherence to Constitution Section 11 (*Tool Principles*), tools must be:
- **Narrow**: Each tool performs exactly one well-defined operation.
- **Typed**: Inputs and outputs are strictly validated via immutable schemas.
- **Observable**: Every invocation produces structured events and verifiable evidence.
- **Timeout-Bounded**: Execution is hard-preempted by timers.
- **Permission-Controlled**: Actions are gated by capability policies derived from the governing [`MissionContract`](../../src/domain/mission-contract.ts).
- **Independently Testable**: Deterministic behavior is verified without stochastic models.

---

## 2. Problem Statement

Autonomous agent frameworks frequently fail in production due to unstructured, over-privileged tool execution:
1. **Unrestricted Shell Execution (`execute_anything`)**: Giving an agent a raw shell tool (`bash -c "..."`) allows prompt injections to execute arbitrary commands, download malware, or escape sandboxes.
2. **Untyped, Dynamic Payload Drift**: When tools accept loose string arguments or return arbitrary unstructured text, subtle model hallucination causes syntax errors, unhandled runtime crashes, and lost updates.
3. **Missing Authorization Gates**: In traditional frameworks, tool calls are dispatched directly to the operating system without checking whether the task or mission authorized that specific capability.
4. **Monolithic Single-Step Deadlock**: Real tasks require iterative sequences (e.g. read file $\rightarrow$ search code $\rightarrow$ apply edit $\rightarrow$ run tests $\rightarrow$ check git status). Executing one operation per Run prevents iterative problem solving.
5. **Unverifiable Claim Fallacy**: Tools often self-report success even if the underlying command produced a non-zero exit code or failed silently.

---

## 3. Goals & Non-Goals

### Goals
- **Strictly Typed Tool Boundary**: Define typed input and output contracts for an initial, essential tool suite (`read_file`, `write_file`, `search_code`, `git_status`, `git_diff`, `run_command`).
- **Capability-Gated Execution**: Every tool operation maps to a distinct, immutable capability identifier authorized upstream by [`PolicyEvaluator`](../../src/domain/policy.ts) against the [`MissionContract`](../../src/domain/mission-contract.ts).
- **Workspace-Constrained Operations**: All file and git operations are confined strictly to the assigned workspace sandbox.
- **Structured Multi-Step Action Execution**: Introduce a coherent multi-step execution model (`Run` $\rightarrow$ `Execution` $\rightarrow$ `Action` $\rightarrow$ `Attempt`) preserving the existing Run state machine.
- **Deterministic Evidence Generation**: Every tool execution generates canonical evidence for post-execution verification.

### Non-Goals
- **No Direct LLM / Agent Orchestrator**: This phase establishes the tool contracts and multi-step execution engine; model adapters and autonomous reasoning loops belong to Phase 7.
- **No Generic Shell Execution Wrapper**: Emerald explicitly rejects `execute_shell_script` or arbitrary string interpolation tools.
- **No Dynamic Tool Generation**: Agents cannot declare or synthesize new tool schemas on the fly.
- **No Human-in-the-Loop Approval Workflow**: Human approval gates remain future extensions; the architecture prepares capability hooks without implementing interactive UI consoles.

---

## 4. The Initial Typed Tool Suite

Emerald defines six primary tool primitives. Each tool belongs to a strict functional category:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                      EMERALD TYPED TOOL SUITE                          │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Read-Only Workspace Tools (Safe, Idempotent)                        │
│    - read_file    (Inspect file contents with line/offset bounding)     │
│    - search_code  (Workspace-wide regex/text search with limit cap)    │
│                                                                        │
│ 2. Git Inspection Tools (Read-Only, Deterministic)                     │
│    - git_status   (Parse clean vs modified working tree state)         │
│    - git_diff     (Inspect unstaged/staged code modifications)          │
│                                                                        │
│ 3. Mutating Workspace Tools (State-Mutating, Path-Sanitized)           │
│    - write_file   (Atomic file write/overwrite with size limits)       │
│                                                                        │
│ 4. Isolated Process Execution Tools (High Risk, Hard-Bounded)          │
│    - run_command  (Execute specific non-interactive command in sandbox)│
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Detailed Tool Specifications

### 5.1 `read_file`

| Attribute | Specification |
| :--- | :--- |
| **Tool Name** | `read_file` |
| **Purpose** | Reads UTF-8 text content from a file inside the workspace sandbox with line/offset bounding. |
| **Capability Identifier** | `workspace.file.read` |
| **Classification** | Read-Only, Idempotent |
| **Required Isolation** | `IN_PROCESS` (if path sanitized) or `ISOLATED` |
| **Resource Limits** | Max file read size: 1 MB (default); Max returned characters: 64,000 |

#### Typed Schemas
```typescript
export const ReadFileInputSchema = z.object({
  path: z.string().min(1).describe("Relative path within the workspace"),
  offsetLine: z.number().int().min(1).optional().default(1),
  limitLines: z.number().int().min(1).max(2000).optional().default(500),
}).strict();

export const ReadFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
  totalLines: z.number().int().nonnegative(),
  isTruncated: z.boolean(),
  contentHash: z.string().length(64), // SHA-256 of file content
}).strict();
```

#### Security & Error Semantics
- Path is validated against directory traversal (`../`) and symlink escapes.
- Errors: `FILE_NOT_FOUND`, `PATH_OUTSIDE_WORKSPACE`, `FILE_TOO_LARGE`, `FILE_IS_BINARY`.

---

### 5.2 `write_file`

| Attribute | Specification |
| :--- | :--- |
| **Tool Name** | `write_file` |
| **Purpose** | Atomically creates or overwrites a text file within the workspace sandbox. |
| **Capability Identifier** | `workspace.file.write` |
| **Classification** | Mutating, State-Altering |
| **Required Isolation** | `ISOLATED` (or trusted in-process path-sanitized) |
| **Resource Limits** | Max write payload: 1 MB; Max workspace quota applied |

#### Typed Schemas
```typescript
export const WriteFileInputSchema = z.object({
  path: z.string().min(1).describe("Relative path within the workspace"),
  content: z.string().describe("UTF-8 text content to write"),
  overwrite: z.boolean().default(true),
}).strict();

export const WriteFileOutputSchema = z.object({
  path: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  created: z.boolean(),
  contentHash: z.string().length(64), // SHA-256 of written content
}).strict();
```

#### Security & Error Semantics
- Pre-write check verifies that writing `content` does not violate workspace disk quotas.
- Intermediate parent directories are created automatically within workspace bounds.
- Writing to symlinks pointing outside the workspace root is rejected with `SYMLINK_ESCAPES_WORKSPACE`.
- Errors: `PATH_OUTSIDE_WORKSPACE`, `DISK_QUOTA_EXCEEDED`, `FILE_ALREADY_EXISTS`, `WRITE_FAILED`.

---

### 5.3 `search_code`

| Attribute | Specification |
| :--- | :--- |
| **Tool Name** | `search_code` |
| **Purpose** | Performs regex or literal text pattern matching across workspace files (equivalent to ripgrep). |
| **Capability Identifier** | `workspace.code.search` |
| **Classification** | Read-Only, Idempotent |
| **Required Isolation** | `IN_PROCESS` (pure code scanner) or `ISOLATED` |
| **Resource Limits** | Max matches returned: 200; Max file search depth: 20; Timeout: 5000ms |

#### Typed Schemas
```typescript
export const SearchCodeInputSchema = z.object({
  query: z.string().min(1).max(500).describe("Search string or regex query"),
  isRegex: z.boolean().default(false),
  subDirectory: z.string().optional().default("."),
  filePattern: z.string().optional().default("*"), // e.g. "*.ts", "*.py"
  maxResults: z.number().int().min(1).max(500).default(50),
}).strict();

export const SearchCodeOutputSchema = z.object({
  query: z.string(),
  matches: z.array(z.object({
    file: z.string(),
    line: z.number().int().positive(),
    content: z.string(),
  })),
  totalMatches: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict();
```

#### Security & Error Semantics
- Regular expressions are evaluated with ReDoS protection (timeout-bounded backtracking).
- Subdirectory paths are strictly clamped inside the workspace root.
- Errors: `INVALID_REGEX`, `PATH_OUTSIDE_WORKSPACE`, `SEARCH_TIMED_OUT`.

---

### 5.4 `git_status`

| Attribute | Specification |
| :--- | :--- |
| **Tool Name** | `git_status` |
| **Purpose** | Inspects repository status, returning modified, staged, untracked, and deleted files. |
| **Capability Identifier** | `git.read` |
| **Classification** | Read-Only, Idempotent |
| **Required Isolation** | `ISOLATED` (executes in sandbox container) |
| **Resource Limits** | Max status entries: 1000; Timeout: 5000ms |

#### Typed Schemas
```typescript
export const GitStatusInputSchema = z.object({}).strict();

export const GitStatusOutputSchema = z.object({
  clean: z.boolean(),
  currentCommit: z.string().length(40),
  modified: z.array(z.string()),
  added: z.array(z.string()),
  deleted: z.array(z.string()),
  untracked: z.array(z.string()),
}).strict();
```

#### Security & Error Semantics
- Runs strictly as `git status --porcelain=v1` inside the sandbox container.
- Errors: `NOT_A_GIT_REPOSITORY`, `GIT_COMMAND_FAILED`, `TIMEOUT`.

---

### 5.5 `git_diff`

| Attribute | Specification |
| :--- | :--- |
| **Tool Name** | `git_diff` |
| **Purpose** | Computes unified diff of working tree changes against the immutable baseline commit. |
| **Capability Identifier** | `git.read` |
| **Classification** | Read-Only, Idempotent |
| **Required Isolation** | `ISOLATED` (executes in sandbox container) |
| **Resource Limits** | Max diff size: 256 KB; Timeout: 5000ms |

#### Typed Schemas
```typescript
export const GitDiffInputSchema = z.object({
  path: z.string().optional().describe("Optional path filter"),
  staged: z.boolean().default(false),
}).strict();

export const GitDiffOutputSchema = z.object({
  diff: z.string(),
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  diffHash: z.string().length(64), // SHA-256 of canonical diff
  isTruncated: z.boolean(),
}).strict();
```

#### Security & Error Semantics
- Produces normalized unified diff text. Sensitive tokens/secrets in diffs are redacted before persistence.
- Errors: `PATH_OUTSIDE_WORKSPACE`, `GIT_COMMAND_FAILED`, `DIFF_TOO_LARGE`.

---

### 5.6 `run_command`

| Attribute | Specification |
| :--- | :--- |
| **Tool Name** | `run_command` |
| **Purpose** | Executes a specific non-interactive command (e.g. `npm test`, `pytest`) inside the isolated container. |
| **Capability Identifier** | `process.execute` |
| **Classification** | Mutating / High-Risk Execution |
| **Required Isolation** | `ISOLATED` (MANDATORY: Never permitted in-process) |
| **Resource Limits** | Timeout: min(request, contract.timeoutMs); Max output: min(request, contract.maxOutputBytes) |

#### Typed Schemas
```typescript
export const RunCommandInputSchema = z.object({
  command: z.string().min(1).max(200).describe("Executable binary name (e.g. npm, pytest, git)"),
  args: z.array(z.string().max(1000)).default([]).describe("Array of discrete string arguments"),
  workingDirectory: z.string().default(".").describe("Subdirectory relative to workspace root"),
  timeoutMs: z.number().int().min(100).max(60000).optional(),
}).strict();

export const RunCommandOutputSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  outputTruncated: z.boolean(),
  commandHash: z.string().length(64), // SHA-256 of canonical command + args
}).strict();
```

#### Strict Anti-Shell Injection Defense
- **Zero Shell Wrapper**: `run_command` passes command and discrete args directly to Node `spawn()` or Docker exec:
  `docker exec <container> <command> <arg1> <arg2> ...`
  It **NEVER** invokes `/bin/sh -c "<interpolated_string>"`.
- **Executable Allowlist / Sanitization**: Semicolons (`;`), pipes (`|`), ampersands (`&`), redirection (`>`), and backticks (`` ` ``) cannot execute shell command chaining because no shell interpreter is invoked.
- **Fail-Closed on Isolation Failure**: If Docker is unavailable, `run_command` **fails closed immediately** with `ISOLATION_REQUIREMENT_NOT_MET`. It will never downgrade to host process execution.
- Errors: `COMMAND_TIMED_OUT`, `OUTPUT_LIMIT_EXCEEDED`, `COMMAND_NOT_FOUND`, `ISOLATION_REQUIREMENT_NOT_MET`.

---

## 6. End-to-End Governance & Relationship Chain

Every tool invocation follows an explicit, unskippable 9-stage pipeline:

```text
               ┌────────────────────────┐
               │    Proposed Action     │ (Tool name, Input arguments)
               └───────────┬────────────┘
                           │
    Stage 1: Policy Gate   ▼
        ┌──────────────────────────────────────┐
        │ PolicyEvaluator.evaluatePolicy()     │
        │ - Is capability in contract.policy?  │ ──(DENIED)──► Terminal FAILED
        │ - What isolation is required?        │               (POLICY_DENIED)
        └──────────────────┬───────────────────┘
                           │ ALLOWED
    Stage 2: Tool Registry ▼
        ┌──────────────────────────────────────┐
        │ ToolRegistry.getTool(toolName)       │
        │ - Validate Input against Zod Schema  │ ──(INVALID)─► Action FAILED
        └──────────────────┬───────────────────┘               (SCHEMA_VIOLATION)
                           │ VALID
    Stage 3: Path Gate     ▼
        ┌──────────────────────────────────────┐
        │ WorkspaceManager.resolvePath()       │
        │ - Resolve lexical & symlink paths    │ ──(ESCAPE)──► Action FAILED
        │ - Assert within workspace root       │               (PATH_TRAVERSAL)
        └──────────────────┬───────────────────┘
                           │ CONTAINED
    Stage 4: Isolation Gate▼
        ┌──────────────────────────────────────┐
        │ WorkerRuntime Isolation Assertion    │
        │ - Does provider satisfy requirement? │ ──(FAIL)────► Terminal FAILED
        └──────────────────┬───────────────────┘               (ISOLATION_NOT_MET)
                           │ SATISFIED
    Stage 5: Ceiling Clamp ▼
        ┌──────────────────────────────────────┐
        │ Resource Clamping Gate               │
        │ - Clamp timeoutMs & maxOutputBytes   │
        │   to contract.spec.resourceLimits    │
        └──────────────────┬───────────────────┘
                           │ CLAMPED
    Stage 6: Execution     ▼
        ┌──────────────────────────────────────┐
        │ ExecutionProvider.execute()          │
        │ - Run inside isolated container      │
        │ - Enforce output streaming caps      │
        └──────────────────┬───────────────────┘
                           │ RESULT
    Stage 7: Output Guard  ▼
        ┌──────────────────────────────────────┐
        │ WorkerRuntime Output Limit Check     │
        │ - Discard if payload > maxOutputBytes│ ──(EXCESS)──► Terminal FAILED
        └──────────────────┬───────────────────┘               (OUTPUT_OVERFLOW)
                           │ BOUNDED
    Stage 8: Evidence Gate ▼
        ┌──────────────────────────────────────┐
        │ createEvidence()                     │
        │ - Redact secrets, sort keys          │
        │ - Compute SHA-256 content digest     │
        │ - Append evidence.recorded event     │
        └──────────────────┬───────────────────┘
                           │ EVIDENCE
    Stage 9: Verifier Gate ▼
        ┌──────────────────────────────────────┐
        │ DeterministicVerifier.verify()       │
        │ - Corroborate evidence against spec  │ ──(FAIL)────► Terminal FAILED
        └──────────────────┬───────────────────┘               (VERIFY_FAILED)
                           │ VERIFIED
                           ▼
                  [ ACTION COMPLETED ]
```

---

## 7. Multi-Step Execution Architecture

To support iterative autonomous agent loops without compromising durability, Emerald decomposes execution into four distinct entities:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ RUN (Durable Orchestration Boundary)                                   │
│  - Identity: runId (UUIDv7)                                            │
│  - Governed by: MissionContract (contractId, version, contentHash)     │
│  - Lifecycle: CREATED → QUEUED → LEASED → RUNNING → COMPLETED / FAILED │
│                                                                        │
│   ┌──────────────────────────────────────────────────────────────────┐ │
│   │ EXECUTION (Worker Lease Turn)                                    │ │
│   │  - Identity: executionId = runId + attemptCount                  │ │
│   │  - Held by: workerId with active leaseId                         │ │
│   │                                                                  │ │
│   │   ┌────────────────────────────────────────────────────────────┐ │ │
│   │   │ ACTION (Discrete Semantic Step)                            │ │ │
│   │   │  - Identity: actionId (UUIDv7), sequence (1..N)            │ │ │
│   │   │  - Target: Tool name + Sanitized input                     │ │ │
│   │   │  - Status: PROPOSED → AUTHORIZED → EXECUTED → COMPLETED    │ │ │
│   │   │                                                            │ │ │
│   │   │   ┌──────────────────────────────────────────────────────┐ │ │ │
│   │   │   │ ATTEMPT (Provider Invocation)                        │ │ │ │
│   │   │   │  - Identity: attemptId (actionId + attemptNumber)    │ │ │ │
│   │   │   │  - Captured: stdout, stderr, exitCode, duration      │ │ │ │
│   │   │   └──────────────────────────────────────────────────────┘ │ │ │
│   │   └────────────────────────────────────────────────────────────┘ │ │
│   └──────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

### 7.1 Entity Responsibility Matrix

| Entity | Identity | Durability | Ownership | Failure / Retry Semantics |
| :--- | :--- | :--- | :--- | :--- |
| **`Run`** | `runId` | Persisted in `runs` table (WAL) | `RunCoordinator` | High-level retries bounded by `contract.maxAttempts`. State machine remains unchanged. |
| **`Execution`** | `runId:attempt` | Relational lease columns on `runs` | Lease-holding Worker | If worker dies, lease expires; sweeper recovers run. |
| **`Action`** | `actionId` | Event log `action.started`, `action.completed` | `WorkerRuntime` | Individual tool invocation step. Failing an action does not fail the whole Run if the agent can handle errors. |
| **`Attempt`** | `actionId:attempt` | Transient runtime provider invocation | `ExecutionProvider` | Physical execution cycle. Bounded by tool timeout. |

### 7.2 Multi-Step Execution Inside the Run State Machine
- The durable `Run` enters `RUNNING` status once claimed.
- While in `RUNNING`, the worker executes a bounded loop of **Actions**.
- Each action appends events: `action.proposed`, `policy.evaluated`, `action.started`, `evidence.recorded`, `action.completed`.
- The `Run` transitions to terminal `COMPLETED` only when:
  1. All required actions have completed.
  2. Final `VerificationSpec` evaluates to `VERIFIED`.
- If an unrecoverable failure occurs (contract revocation, policy breach, output overflow, verifier failure), the `Run` transitions to `FAILED`.

---

## 8. Mission Contract Compatibility & Authority Evolution

The Mission Contract (Task 1.8C) is **strictly frozen**. Tool execution consumes existing contract authority without modifying contract schemas:

### 8.1 Capability Vocabulary Evolution
The pure domain capability vocabulary ([`src/domain/capability.ts`](../../src/domain/capability.ts)) cleanly extends from initial primitives to tool capabilities:

```typescript
export const TOOL_CAPABILITIES = [
  "workspace.file.read",
  "workspace.file.write",
  "workspace.code.search",
  "git.read",
  "process.execute",
] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];
```
- A `MissionContractSpec.policy.allowedCapabilities` array authorizes the tool capabilities.
- If a contract contains `workspace.file.read`, `read_file` is permitted.
- If a contract omits `process.execute`, any call to `run_command` is rejected by [`PolicyEvaluator`](../../src/domain/policy.ts) with `CAPABILITY_NOT_GRANTED`.

### 8.2 Resource Ceiling Inheritance
- `MissionContract.spec.resourceLimits.timeoutMs` acts as the global ceiling for the entire Run. Tool-level timeouts (`action.timeoutMs`) can narrow the ceiling but cannot exceed it:
  $$\text{effectiveTimeoutMs} = \min(\text{toolRequest.timeoutMs}, \text{contract.resourceLimits.timeoutMs})$$
- `MissionContract.spec.resourceLimits.maxOutputBytes` enforces a hard ceiling across all tool actions.

### 8.3 Revocation Invariant
If an administrator revokes a `MissionContract` (`status = 'REVOKED'`):
1. **Next Action Blocked**: `WorkerRuntime` verifies contract status before authorizing each action. If revoked, execution halts immediately with `CONTRACT_REVOKED`.
2. **In-Flight Action Termination**: The active container is destroyed via `docker kill`.
3. **No Recovery**: Sweeper refuses to re-queue the run, transitioning it to terminal `FAILED`.
4. **Historical Evidence Preserved**: Evidence produced by prior actions remains immutable in `run_events`.

---

## 9. Failure Semantics Matrix

| Failure Mode | Retryable? | Terminal State? | Provider Invoked? | Evidence Emitted? | Workspace Cleaned? |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Workspace Creation Failure** | Yes (transient) | `FAILED` if exhausted | No | No | Yes (immediate) |
| **Repo Acquisition Failure** | No | `FAILED` | No | No | Yes |
| **Tool Input Schema Failure** | No (action error) | None (agent retries) | No | No | No |
| **Capability Policy Denied** | No | `FAILED` (`POLICY_DENIED`) | No | Yes (`policy.evaluated`)| Yes |
| **Path Traversal Detected** | No | `FAILED` (`SECURITY_VIOLATION`)| No | Yes (`security.violation`)| Yes |
| **Isolation Requirement Mismatch** | No | `FAILED` (`ISOLATION_NOT_MET`)| No | Yes | Yes |
| **Command Timeout (run_command)** | No (action error) | None (reported to tool)| Yes (aborted)| Yes (`evidence.recorded`)| No |
| **Output Flooding (>1MB)** | No | `FAILED` (`OUTPUT_EXCEEDED`)| Yes (killed) | No (discarded) | Yes |
| **Verifier Rejection** | No | `FAILED` (`VERIFY_FAILED`) | Yes | Yes | Yes |
| **Contract Revocation Mid-Run** | No | `FAILED` (`CONTRACT_REVOKED`) | Aborted | Yes | Yes |

---

## 10. Security Threat Model

In accordance with Master Engineering Constitution Section 12 (*Security*), the threat model evaluates 30 distinct attack vectors across four defense rings:

### 10.1 Path & Filesystem Traversal
1. **`../` Traversal**: Blocked by lexical resolution and `isSubpath()` assertion against workspace root.
2. **Absolute Path Escape (`/etc/shadow`)**: Leading slashes are stripped or resolved relative to `/workspace`. Outside paths trigger `PATH_OUTSIDE_WORKSPACE`.
3. **Symlink Escape (`link -> /home/user`)**: `realpath()` resolves target; if canonical target is outside workspace root, operation fails closed (`SYMLINK_ESCAPES_WORKSPACE`).
4. **Hard-Link Abuse**: Hard links pointing across filesystem boundaries fail. Host directory is on an isolated mount.
5. **Symlink Attacks During Cleanup**: `rm -rf` uses non-following unlink primitives, preventing deletion of host targets via symlinks.
6. **Malicious Filenames**: NUL bytes (`\0`), control characters, and reserved Windows device names (`CON`, `PRN`, `AUX`) are rejected during schema validation.
7. **Binary File Exploits**: File read tools inspect MIME/binary signatures; binary files reject text reads to prevent buffer overruns or encoding exploits.
8. **Oversized Reads/Writes**: Capped by strict schema and memory limits (`maxFileSizeBytes = 10MB`).

### 10.2 Host & Container Isolation
9. **Host Filesystem Exposure**: The container rootfs is read-only (`--read-only`); host root is never mounted.
10. **Docker Socket Exposure**: `/var/run/docker.sock` is strictly forbidden from entering any container.
11. **Container Escape Vectors**: Host OS kernel is shared via WSL2/cgroups. Containers drop all capabilities (`--cap-drop=ALL`) and enable `no-new-privileges`.
12. **Fork Bombs / Process Storms**: Capped via Linux cgroups process quota (`--pids-limit=64`).
13. **Disk Exhaustion**: Host monitors workspace disk byte count; excess allocations trigger `DISK_QUOTA_EXCEEDED`.
14. **Output Flooding**: Stdout/stderr stream byte counter destroys container if output exceeds 1 MB.
15. **Network Access**: Container network is completely severed (`--network=none`). Normal outbound connections are blocked.

### 10.3 Credential & Environment Protection
16. **Host Environment Leakage**: Containers do not inherit host environment variables (`process.env`). Clean environment dictionaries are explicitly injected.
17. **SSH Key Leakage**: `~/.ssh` is never mounted, copied, or referenced.
18. **Git Credential Leakage**: Git clones strip credential helper configs before handoff to the workspace.
19. **Secret Redaction in Evidence**: [`canonical-hash.ts`](../../src/domain/canonical-hash.ts) deterministically redacts sensitive keys (`token`, `secret`, `password`, `credential`, `authorization`) before persistence.
20. **Malicious Build Scripts (`npm install`, `setup.py`)**: Arbitrary background scripts cannot access network or host sockets, preventing secret exfiltration during builds.

### 10.4 Workspace Concurrency & Lifecycle
21. **Cross-Run Contamination**: Each Run provisions a fresh, dedicated workspace directory. Workspaces are never recycled across runs.
22. **Concurrent Access Races**: Lease fencing tokens (`lease_id`) guarantee exactly one worker writes to a workspace.
23. **Stale Workspace Reuse**: Reclaimed orphaned workspaces are purged by the sweeper, never reused.

---

## 11. Observability & Latency Decomposition Contract

To satisfy Constitution Section 18 (*Latency Model*), every step of tool and workspace execution exposes concrete latency telemetry hooks:

```text
total_run_latency
  ├── queue_wait_ms            (T_leased - T_queued)
  ├── contract_resolution_ms   (Time to resolve and verify MissionContract)
  ├── workspace_provision_ms   (Time to create directory and set permissions)
  ├── repository_setup_ms      (Time to checkout immutable revision SHA)
  ├── sandbox_start_ms         (Time to initialize container process)
  ├── multi_step_execution_ms  (Sum of all action execution times)
  │     ├── action_policy_eval_ms
  │     ├── tool_validation_ms
  │     └── tool_execution_ms
  ├── verification_ms          (DeterministicVerifier evaluation time)
  └── workspace_cleanup_ms     (Time to dispose container and unmount/delete workspace)
```

No heuristic optimization may be promoted in Reflex (Phase 11) without attributing latency reductions to one of these measured components.

---

## 12. Explicit Invariants

1. **Mission Authority Invariant**: No tool action may execute without explicit capability authorization from the governing [`MissionContract`](../../src/domain/mission-contract.ts).
2. **Zero Shell Bypass Invariant**: All command execution must pass through structured `run_command` arguments. Raw shell strings and shell interpreters are forbidden.
3. **Path Containment Invariant**: All workspace tools are physically and logically restricted to the workspace root.
4. **Mandatory Isolation Invariant**: Tools requiring `ISOLATED` execution must never downgrade to in-process execution.
5. **Multi-Step Binding Invariant**: Every action in a multi-step execution remains permanently bound to the original MissionContract version and hash.
6. **Fail-Closed Revocation Invariant**: A revoked MissionContract halts multi-step execution prior to the next action and fails closed during recovery.
7. **Auditable Evidence Invariant**: Every mutating tool action produces canonical, redacted, content-hashed evidence.
