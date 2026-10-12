# Emerald Agent Fabric: Typed Tool System & Multi-Step Execution Architecture

## Document Information
- **Status**: Architecture Specification â€” Phase 4 Baseline
- **Governing Constitution**: [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- **Layer**: Architecture Specification
- **Related ADR**: [ADR-0003: Workspace Sandbox Boundary and Typed Tool System Architecture](../adr/ADR-0003-workspace-and-typed-tools.md), [ADR-0004: Tool Execution Gateway, Adapter Boundary, and Multi-Step Action Lifecycle](../adr/ADR-0004-tool-execution-gateway-and-adapter-boundary.md)
- **Upstream Dependencies**: [Workspace Sandbox Architecture](./workspace-sandbox.md), [Runtime Architecture](./runtime.md), [Security Architecture](./security.md)

---

## 1. Context & Background

In Capability 1 (Tasks 1.1â€“1.8C), Emerald established a deterministic, crash-recoverable execution substrate. Operations are currently restricted to four toy mathematical primitives (`execution.echo`, `execution.sum`, `execution.slow`, `execution.fail`) dispatched as a single monolithic execution per `Run`.

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
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                      EMERALD TYPED TOOL SUITE                          â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚ 1. Read-Only Workspace Tools (Safe, Idempotent)                        â”‚
â”‚    - read_file    (Inspect file contents with line/offset bounding)     â”‚
â”‚    - search_code  (Workspace-wide regex/text search with limit cap)    â”‚
â”‚                                                                        â”‚
â”‚ 2. Git Inspection Tools (Read-Only, Deterministic)                     â”‚
â”‚    - git_status   (Parse clean vs modified working tree state)         â”‚
â”‚    - git_diff     (Inspect unstaged/staged code modifications)          â”‚
â”‚                                                                        â”‚
â”‚ 3. Mutating Workspace Tools (State-Mutating, Path-Sanitized)           â”‚
â”‚    - write_file   (Atomic file write/overwrite with size limits)       â”‚
â”‚                                                                        â”‚
â”‚ 4. Isolated Process Execution Tools (High Risk, Hard-Bounded)          â”‚
â”‚    - run_command  (Execute specific non-interactive command in sandbox)â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
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
               â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
               â”‚    Proposed Action     â”‚ (Tool name, Input arguments)
               â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                           â”‚
    Stage 1: Policy Gate   â–¼
        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
        â”‚ PolicyEvaluator.evaluatePolicy()     â”‚
        â”‚ - Is capability in contract.policy?  â”‚ â”€â”€(DENIED)â”€â”€â–º Terminal FAILED
        â”‚ - What isolation is required?        â”‚               (POLICY_DENIED)
        â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                           â”‚ ALLOWED
    Stage 2: Tool Registry â–¼
        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
        â”‚ ToolRegistry.getTool(toolName)       â”‚
        â”‚ - Validate Input against Zod Schema  â”‚ â”€â”€(INVALID)â”€â–º Action FAILED
        â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜               (SCHEMA_VIOLATION)
                           â”‚ VALID
    Stage 3: Path Gate     â–¼
        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
        â”‚ WorkspaceManager.resolvePath()       â”‚
        â”‚ - Resolve lexical & symlink paths    â”‚ â”€â”€(ESCAPE)â”€â”€â–º Action FAILED
        â”‚ - Assert within workspace root       â”‚               (PATH_TRAVERSAL)
        â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                           â”‚ CONTAINED
    Stage 4: Isolation Gateâ–¼
        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
        â”‚ WorkerRuntime Isolation Assertion    â”‚
        â”‚ - Does provider satisfy requirement? â”‚ â”€â”€(FAIL)â”€â”€â”€â”€â–º Terminal FAILED
        â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜               (ISOLATION_NOT_MET)
                           â”‚ SATISFIED
    Stage 5: Resource Gate â–¼
        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
        â”‚ Resource Authority Validation        â”‚
        â”‚ - IF requested > contract ceiling:   â”‚ â”€â”€(EXCEEDED)â–º Action REJECTED
        â”‚   REJECT (ResourceLimitExceededError)â”‚               (Zero Execution)
        â”‚ - IF requested <= ceiling: ACCEPT    â”‚
        â”‚ - effective = min(requested, safety) â”‚
        â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                           â”‚ AUTHORIZED
    Stage 6: Execution     â–¼
        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
        â”‚ ExecutionProvider.execute()          â”‚
        â”‚ - Run inside isolated container      â”‚
        â”‚ - Enforce output streaming caps      â”‚
        â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                           â”‚ RESULT
    Stage 7: Output Guard  â–¼
        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
        â”‚ WorkerRuntime Output Limit Check     â”‚
        â”‚ - Discard if payload > maxOutputBytesâ”‚ â”€â”€(EXCESS)â”€â”€â–º Terminal FAILED
        â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜               (OUTPUT_OVERFLOW)
                           â”‚ BOUNDED
    Stage 8: Evidence Gate â–¼
        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
        â”‚ createEvidence()                     â”‚
        â”‚ - Redact secrets, sort keys          â”‚
        â”‚ - Compute SHA-256 content digest     â”‚
        â”‚ - Append evidence.recorded event     â”‚
        â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                           â”‚ EVIDENCE
    Stage 9: Verifier Gate â–¼
        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
        â”‚ DeterministicVerifier.verify()       â”‚
        â”‚ - Corroborate evidence against spec  â”‚ â”€â”€(FAIL)â”€â”€â”€â”€â–º Terminal FAILED
        â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜               (VERIFY_FAILED)
                           â”‚ VERIFIED
                           â–¼
                  [ ACTION COMPLETED ]
```

---

## 7. Multi-Step Execution Architecture

To support iterative autonomous agent loops without compromising durability, Emerald decomposes execution into four distinct entities:

```text
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ RUN (Durable Orchestration Boundary)                                   â”‚
â”‚  - Identity: runId (UUIDv7)                                            â”‚
â”‚  - Governed by: MissionContract (contractId, version, contentHash)     â”‚
â”‚  - Lifecycle: CREATED â†’ QUEUED â†’ LEASED â†’ RUNNING â†’ COMPLETED / FAILED â”‚
â”‚                                                                        â”‚
â”‚   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â” â”‚
â”‚   â”‚ EXECUTION (Worker Lease Turn)                                    â”‚ â”‚
â”‚   â”‚  - Identity: executionId = runId + attemptCount                  â”‚ â”‚
â”‚   â”‚  - Held by: workerId with active leaseId                         â”‚ â”‚
â”‚   â”‚                                                                  â”‚ â”‚
â”‚   â”‚   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â” â”‚ â”‚
â”‚   â”‚   â”‚ ACTION (Discrete Semantic Step)                            â”‚ â”‚ â”‚
â”‚   â”‚   â”‚  - Identity: actionId (UUIDv7), sequence (1..N)            â”‚ â”‚ â”‚
â”‚   â”‚   â”‚  - Target: Tool name + Sanitized input                     â”‚ â”‚ â”‚
â”‚   â”‚   â”‚  - Status: PROPOSED â†’ AUTHORIZED â†’ EXECUTED â†’ COMPLETED    â”‚ â”‚ â”‚
â”‚   â”‚   â”‚                                                            â”‚ â”‚ â”‚
â”‚   â”‚   â”‚   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â” â”‚ â”‚ â”‚
â”‚   â”‚   â”‚   â”‚ ATTEMPT (Provider Invocation)                        â”‚ â”‚ â”‚ â”‚
â”‚   â”‚   â”‚   â”‚  - Identity: attemptId (actionId + attemptNumber)    â”‚ â”‚ â”‚ â”‚
â”‚   â”‚   â”‚   â”‚  - Captured: stdout, stderr, exitCode, duration      â”‚ â”‚ â”‚ â”‚
â”‚   â”‚   â”‚   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜ â”‚ â”‚ â”‚
â”‚   â”‚   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜ â”‚ â”‚
â”‚   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜ â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
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

### 8.2 Resource Ceiling Authority & Operational Limits

Tool execution operates under strict governance boundaries, distinguishing between authoritative governance ceilings, requested operational values, and effective execution limits:

#### 1. Resource Authorization Hierarchy

```text
MissionContract ceiling (Authoritative Governance Bound)
        â†“
requested operational value (Tool action / Run creation)
        â†“
        â”œâ”€â”€ requested > ceiling
        â”‚       â†“
        â”‚     REJECT (ResourceLimitExceededError â€” Zero Execution)
        â”‚
        â””â”€â”€ requested <= ceiling
                â†“
             ACCEPT
                â†“
        effective operational limit = min(requested, provider/tool safety limit)
```

We distinguish strictly between:
1. **Authorization Ceiling**: The maximum immutable limit permitted by the governing `MissionContract.spec.resourceLimits`.
2. **Requested Operational Value**: The value explicitly requested by the caller, agent, or tool action parameter.
3. **Effective Operational Limit**: A value equal to or narrower than the authorized ceiling, optionally constrained by provider/tool safety limits. The effective value must **NEVER** be used to hide an unauthorized broader request.

#### 2. Required Architecture Rule

> **A lower operational limit MAY narrow authorized execution.**
>
> **A requested limit above MissionContract authority MUST be rejected.**
>
> **No layer may silently convert an unauthorized request into an authorized narrower request.**

Example:
```text
Contract timeout ceiling = 30s
Action requested timeout = 20s                     â†’ ACCEPT (within authority)
Action requested timeout = 30s                     â†’ ACCEPT (within authority)
Action requested timeout = 40s                     â†’ REJECT (ResourceLimitExceededError â€” zero execution)

If provider imposes an internal safety maximum = 10s:
Contract ceiling = 30s, Request = 20s, Provider max = 10s â†’ Effective limit = 10s (Narrowing authorized request is permitted)
Contract ceiling = 30s, Request = 40s, Provider max = 10s â†’ MUST NOT silently become 10s â†’ MUST REJECT
```

#### 3. Resource Terminology Mapping

The repository's established resource terminology is strictly preserved without schema mutation:

| Layer / Entity | Property Name | Governance Category | Semantics & Authority |
| :--- | :--- | :--- | :--- |
| **MissionContract** (`contract.spec.resourceLimits`) | `timeoutMs` | Authorization Ceiling | Authoritative ceiling on total Run execution wall-clock time. |
| | `maxAttempts` | Authorization Ceiling | Authoritative ceiling on total Run retry attempts. |
| | `maxOutputBytes` | Authorization Ceiling | Authoritative ceiling on output bytes across execution and tool operations. |
| **Run Aggregate** (`RunSnapshot`) | `run.timeoutMs` | Operational Snapshot | Effective Run timeout; rejected if `> contract.spec.resourceLimits.timeoutMs`. |
| | `run.maxAttempts` | Operational Snapshot | Effective attempt count; rejected if `> contract.spec.resourceLimits.maxAttempts`. |
| | `run.maxOutputBytes` | Operational Snapshot | Effective output size; rejected if `> contract.spec.resourceLimits.maxOutputBytes`. |
| **Tool Action Request** (`ToolInput`) | `toolInput.timeoutMs` | Requested Operational Value | Requested tool execution timeout; rejected if `> run.timeoutMs` or contract ceiling. |
| | `toolInput.maxBytes` | Requested Operational Value | Requested file read or patch size; rejected if `> contract.spec.resourceLimits.maxOutputBytes`. |
| | `toolInput.maxLines` | Requested Operational Value | Requested window lines; bounded by tool-level safety limits. |
| | `toolInput.maxResults` | Requested Operational Value | Requested search results; bounded by tool-level safety limits (e.g. 100). |
| **Workspace Sandbox** (`WorkspaceSpec`) | `maxWorkspaceBytes` | Provider Safety Limit | Host directory storage quota (default 500 MB). *Provider/host safety limit (not in contract schema)*. |
| | `maxFileSizeBytes` | Effective Limit | Single file write limit; rejected if `> contract.spec.resourceLimits.maxOutputBytes`. |
| | `maxFileCount` | Provider Safety Limit | Host inode quota (default 50,000 files). *Provider safety limit against disk exhaustion*. |
| **Provider Execution** (`DockerExecutionConfig`) | `timeoutMs` | Execution Guard | Container execution timer; must be <= authorized `run.timeoutMs`. |
| | `maxOutputBytes` | Execution Guard | Stdout streaming truncation limit; must be <= authorized `run.maxOutputBytes`. |
| | `memoryLimit` | Provider Safety Limit | Linux cgroup memory limit (default 256m). *Provider safety limit*. |
| | `cpuLimit` | Provider Safety Limit | Linux cgroup CPU limit (default 0.5). *Provider safety limit*. |
| | `pidsLimit` | Provider Safety Limit | Linux cgroup pid limit (default 64). *Provider safety limit*. |

Where a resource (such as workspace disk bytes, memory limit, or process count) is not currently part of the `MissionContract.spec.resourceLimits` schema, it is explicitly classified as a **provider/tool safety limit** rather than contract authority.

### 8.3 Honest Revocation Invariant & Process Termination Semantics

The governance boundary enforces strict fail-closed lifecycle handling:

```text
MissionContract ACTIVE
        â†“
Action authorization
        â†“
Tool execution
```

If the contract becomes `REVOKED`:

```text
current action
     â†“
finish / terminate according to defined semantics
     â†“
NO NEXT ACTION
     â†“
workspace cleanup
```

**Exact Process Termination Guarantees**:
1. **Pre-Action Synchronous Boundary**: `WorkerRuntime` verifies `contract.lifecycle.status === "ACTIVE"` before authorizing each tool action. If revoked, execution is blocked immediately with `CONTRACT_REVOKED`, and **`NO NEXT ACTION`** is executed.
2. **In-Flight Action Termination**:
   - *Container Isolation (`DockerExecutionProvider`)*: When revocation occurs mid-action, the provider initiates a physical container termination attempt (`docker kill <containerName>` and `docker rm -f <containerName>`). However, because external OS and daemon process termination is inherently asynchronous, instant sub-millisecond preemption cannot be guaranteed.
   - *In-Process Operations (Node.js runtime)*: Node.js single-threaded execution cannot asynchronously preempt synchronous CPU-bound operations or blocking file I/O calls until control returns to the event loop.
3. **Guaranteed Post-Revocation Cleanup**: Once the in-flight attempt terminates or yields, the runtime guarantees that no subsequent action will ever execute (`NO NEXT ACTION`). The workspace directory is unconditionally unlinked via `WorkspaceManager.disposeWorkspace()`, and the `Run` transitions to terminal `FAILED` with error code `CONTRACT_REVOKED`.
4. **Historical Evidence Preserved**: Evidence payloads recorded for prior completed actions remain immutable in `run_events`. Sweepers will not recover or re-queue revoked runs.

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
  â”œâ”€â”€ queue_wait_ms            (T_leased - T_queued)
  â”œâ”€â”€ contract_resolution_ms   (Time to resolve and verify MissionContract)
  â”œâ”€â”€ workspace_provision_ms   (Time to create directory and set permissions)
  â”œâ”€â”€ repository_setup_ms      (Time to checkout immutable revision SHA)
  â”œâ”€â”€ sandbox_start_ms         (Time to initialize container process)
  â”œâ”€â”€ multi_step_execution_ms  (Sum of all action execution times)
  â”‚     â”œâ”€â”€ action_policy_eval_ms
  â”‚     â”œâ”€â”€ tool_validation_ms
  â”‚     â””â”€â”€ tool_execution_ms
  â”œâ”€â”€ verification_ms          (DeterministicVerifier evaluation time)
  â””â”€â”€ workspace_cleanup_ms     (Time to dispose container and unmount/delete workspace)
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

---

## 13. Task 4.1 Domain Contracts, Schemas & Error Taxonomy Status

Task 4.1 establishes the pure, strongly typed domain contracts for tools without implementing adapters, execution gateways, or agent loops.

### 13.1 Tool Domain Boundary
1. **Initial Tool Primitives**: Exactly six stable tools: `read_file`, `write_file`, `search_code`, `git_status`, `git_diff`, `run_command`.
2. **Capability Mapping**:
   - `read_file` $\rightarrow$ `workspace.file.read`
   - `write_file` $\rightarrow$ `workspace.file.write`
   - `search_code` $\rightarrow$ `workspace.code.search`
   - `git_status` $\rightarrow$ `git.read`
   - `git_diff` $\rightarrow$ `git.read`
   - `run_command` $\rightarrow$ `process.execute`
3. **Idempotency Classification**:
   - `read_file`, `search_code`, `git_status`, `git_diff` are declared `IDEMPOTENT`.
   - `write_file`, `run_command` are declared `NON_IDEMPOTENT`.
4. **Isolation Classification**:
   - `read_file`, `write_file`, `search_code`, `git_status`, `git_diff` require `WORKSPACE` isolation.
   - `run_command` requires `SANDBOX` isolation.
5. **Resource Semantics**:
   - Resources (`maxBytes`, `timeoutMs`, `maxResults`, `maxOutputBytes`) are explicitly typed and validated.
   - Schemas never perform silent clamping. Any requested limit above MissionContract ceilings must be rejected by future governance/gateway enforcement.
6. **run_command Security Boundary**:
   - Strict `argv: string[]` discrete token array with non-empty executable `argv[0]`.
   - Raw shell strings (`bash -c`, command interpolation) are categorically rejected.
7. **Trust Boundary**:
   - Tool requests are untrusted inputs proposing `toolName` and `input`.
   - Authority (MissionContract binding, capability authorization, workspace containment, provider dispatch) remains strictly external and enforced by trusted runtime layers.
8. **Error Taxonomy**:
   - Nine deterministic error codes categorized across `validation`, `authorization`, `workspace`, `resource`, `execution`, `cancellation`, and `provider`:
     - `TOOL_NOT_FOUND` (`provider`)
     - `INVALID_TOOL_INPUT` (`validation`)
     - `CAPABILITY_DENIED` (`authorization`)
     - `WORKSPACE_BOUNDARY_VIOLATION` (`workspace`)
     - `TOOL_TIMEOUT` (`resource`)
     - `TOOL_OUTPUT_LIMIT_EXCEEDED` (`resource`)
     - `TOOL_EXECUTION_FAILED` (`execution`)
     - `TOOL_CANCELLED` (`cancellation`)
     - `TOOL_PROVIDER_UNAVAILABLE` (`provider`)
9. **Scope Exclusions (What Task 4.1 Intentionally Does Not Implement)**:
   - Tool Execution Gateway (Task 4.2+)
   - Tool Adapters (filesystem, git CLI, Docker spawn)
   - Multi-step Action / Attempt persistence
   - LLM / Agent reasoning loops

---

## 14. Task 4.2 Architecture Specification: Tool Execution Gateway, Adapter Boundary & Multi-Step Lifecycle

Task 4.2 establishes the architectural design for executing typed tools within the Emerald Agent Fabric. It defines how untrusted `ToolRequest` payloads safely transition into governed, contained operations without bypassing Mission Contract authority or compromising the hardened workspace boundary.

### 14.1 Architecture Decision: Hexagonal Alternative C
We formally adopt **Alternative C (Modular Hexagonal Architecture)**:
1. **ToolExecutionGateway**: Trusted application coordinator orchestrating tool lookup, schema validation, capability checks against `PolicyEvaluator`, non-clamping resource ceiling checks, and adapter dispatch.
2. **Tool Adapters**: Pluggable adapters implementing `ToolAdapterPort` that encapsulate specific execution mechanics without leaking governance logic or acquiring unnecessary system authorities.
3. **ExecutionProvider**: Low-level container runtime (`DockerExecutionProvider`) reserved strictly for high-risk process isolation (`run_command`), never bypassed.
4. **WorkspacePort**: Authoritative boundary for canonical filesystem containment and directory lifecycle management.

### 14.2 The 11-Stage Tool Execution Pipeline
Every tool invocation dispatches through an unskippable 11-stage pipeline:
```text
Stage 1:  Tool Resolution          â”€â”€â–º ToolRegistryPort.getTool(toolName)
Stage 2:  Contract Status Check    â”€â”€â–º Verify contract.lifecycle.status === "ACTIVE"
Stage 3:  Capability Policy Gate   â”€â”€â–º PolicyEvaluator.evaluate(requiredCapability)
Stage 4:  Resource Authority Gate  â”€â”€â–º Reject if requested > contract ceiling (Zero Execution)
Stage 5:  Input Schema Validation  â”€â”€â–º Zod .parse(input) (strict, rejects unknown keys)
Stage 6:  Lexical Path Sanitize    â”€â”€â–º sanitizeWorkspacePath(path) (blocks traversal/UNC)
Stage 7:  Adapter Dispatch         â”€â”€â–º ToolAdapter.execute(context, validatedInput)
Stage 8:  Physical Execution       â”€â”€â–º WorkspacePort (fs) or ExecutionProvider (Docker)
Stage 9:  Output Schema & Caps     â”€â”€â–º Zod .parse(output) + maxOutputBytes bounding
Stage 10: Canonical Evidence       â”€â”€â–º Secret redaction, key sorting, SHA-256 digest
Stage 11: Audit Event Commit       â”€â”€â–º Append-only event store commit under OCC lease fence
```

### 14.3 Trust Boundary & Untrusted Request Model
- **Untrusted External Domain**: Model-proposed `toolName`, `input` parameters, repository files, subprocess stdout/stderr, git metadata.
- **Trusted Internal Domain**: `runId`, `taskId`, `workerId`, `leaseId`, bound `MissionContract`, `workspaceHandle`, resource ceilings, capability policy, system clock.
- **Transition Boundary**: The `ToolRequest` carries only `requestId`, `toolName`, and `input`. The Gateway injects the ambient, trusted `ToolExecutionContext` held by `WorkerRuntime`. Models cannot forge authority or mutate governance identity.

### 14.4 Capability Authorization & Exact Contract Binding
- **Deterministic Mapping**:
  - `read_file` $\rightarrow$ `workspace.file.read`
  - `write_file` $\rightarrow$ `workspace.file.write`
  - `search_code` $\rightarrow$ `workspace.code.search`
  - `git_status` $\rightarrow$ `git.read`
  - `git_diff` $\rightarrow$ `git.read`
  - `run_command` $\rightarrow$ `process.execute`
- **Exact Binding Invariant**: The Gateway verifies the exact `(contractId, version)` bound to the active `Run`. Dynamic lookups for "latest" contracts or synthetic fallbacks are strictly prohibited.
- **Fail-Closed Gate**: Capability denial halts execution immediately with `CAPABILITY_DENIED` (`FORBIDDEN`); zero adapter code and zero physical processes are invoked.

### 14.5 Resource Authority: Non-Clamping Rejection Model
Resource authorization strictly enforces the frozen governance invariant:
```text
requested > contract ceiling   â”€â”€â–º REJECT (ResourceLimitExceededError â€” Zero Execution)
requested <= contract ceiling  â”€â”€â–º ACCEPT (effective = min(requested, providerSafetyLimit))
```
Silent clamping of unauthorized requests is strictly prohibited. Lower provider safety limits may narrow an authorized request, but can never legitimize an unauthorized broader request.

### 14.6 Tool Adapter Boundary & Interface Specification
Adapters implement the narrow `ToolAdapter` port and receive minimal execution authority:
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

#### Four Dedicated Adapter Implementations:
1. **`LocalFilesystemToolAdapter`**: Handles `read_file` and `write_file` through `WorkspacePort` with atomic temp-file renames and realpath canonicalization.
2. **`WorkspaceSearchToolAdapter`**: Handles `search_code` via timeout-bounded regex scanning confined strictly to the workspace root.
3. **`WorkspaceGitToolAdapter`**: Handles `git_status` and `git_diff` via read-only queries executed inside the workspace root.
4. **`SandboxedCommandToolAdapter`**: Handles `run_command` via mandatory delegation to `ExecutionProvider` in Docker container with dropped capabilities and `--network none`.

### 14.7 Hierarchical Multi-Step Execution Abstractions
Emerald establishes five discrete execution concepts:

| Concept | Purpose | Created By | Trust Level | Persistence | Retry Semantics | Identity | Lifecycle |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`ToolRequest`** | Model-proposed single tool call. | Model / Agent Loop | Untrusted | Not persisted directly; logged in audit stream. | None. | `requestId` | Proposed $\rightarrow$ Authorized / Denied |
| **`Action`** | Logical sequential step in a plan. | `WorkerRuntime` / Controller | Trusted Domain Entity | Persisted in event store (`action.started`, `action.completed`). | Retried across attempts if transient. | `actionId`, `sequence` ($1..N$) | Proposed $\rightarrow$ Authorized $\rightarrow$ Executing $\rightarrow$ Done |
| **`Attempt`** | Single physical execution of an action. | `ToolExecutionGateway` | Trusted Runtime Entity | Recorded in attempt evidence metadata. | Fails individually; retries create attempt $N+1$. | `attemptId` (`actionId:attemptNumber`) | Started $\rightarrow$ Succeeded / Failed / Timed Out |
| **`ExecutionRequest`** | Low-level sandbox execution payload. | `SandboxedCommandToolAdapter` | Internal System Port | Ephemeral provider argument. | Provider executes once; reports outcome. | `runId`, `taskId`, `idempotencyToken` | Dispatched $\rightarrow$ Finished |
| **`ExecutionResult`** | Raw physical outcome from provider. | `ExecutionProvider` | Physical Environment | Captured in Attempt evidence. | Immutable result record. | Correlated to `ExecutionRequest` | Completed (Exit code, stdout, stderr) |

### 14.8 Formal Resolutions to the Six Critical Architectural Questions
1. **Action/Attempt Domain Introduction**: Pure domain contracts and value types are introduced in Task 4.2 architecture; SQLite schema migrations and persistent database tables are deferred to Task 4.4 when the multi-step runtime loop is implemented.
2. **Authorization Ownership**: The Gateway coordinates authorization by invoking the existing pure domain `PolicyEvaluator` against the bound `MissionContract`. A redundant "AuthorizationService" is rejected.
3. **Crash Consistency & Event Ordering**: Strict causal sequence:
   `action.proposed` $\rightarrow$ `tool.authorized` $\rightarrow$ `action.started` $\rightarrow$ physical execution $\rightarrow$ `action.completed` / `action.failed` $\rightarrow$ `tool.completed` / `tool.failed`. Completion is never emitted before side effects and state are durable.
4. **Abstraction Differentiation Matrix**: Fully codified in the comparison matrix above (Section 14.7).
5. **Authoritative Retry Owner**: Exclusively owned by `WorkerRuntime` / Action Controller. Adapters and ExecutionProviders fail closed immediately and never retry autonomously. Non-idempotent tools (`write_file`, `run_command`) are never automatically retried.
6. **LLM ExecutionProvider Direct Bypass Prevention**: `ExecutionProvider` is an internal port in `src/ports/` accessible only by trusted adapters. The LLM only interacts via the `ToolRequest` API mediated by `ToolExecutionGateway`, which strictly validates tool names against `StaticToolRegistry`.

### 14.9 Error Taxonomy & Sanitization Boundary
- Mapped across 9 deterministic codes: `TOOL_NOT_FOUND`, `INVALID_TOOL_INPUT`, `CAPABILITY_DENIED`, `WORKSPACE_BOUNDARY_VIOLATION`, `TOOL_TIMEOUT`, `TOOL_OUTPUT_LIMIT_EXCEEDED`, `TOOL_EXECUTION_FAILED`, `TOOL_CANCELLED`, `TOOL_PROVIDER_UNAVAILABLE`.
- Output sanitization strips host filesystem paths and redacts environment credentials before errors or results are exposed to LLM reasoning loops or external logs.

### 14.10 Security Threat Model (24 Threat Vectors)
Comprehensive analysis completed and documented in [ADR-0004](../adr/ADR-0004-tool-execution-gateway-and-adapter-boundary.md#14-comprehensive-security-threat-model-24-threat-vectors). Dual-boundary filesystem protection, discrete `argv` token execution, strict Zod validation, lease fencing tokens, and container capability dropping prevent path traversal, shell injection, privilege escalation, and cross-run contamination.

### 14.11 Observability & Latency Decomposition Contract
Exposes 11 discrete measurement intervals across the execution pipeline (`stage1_registry_lookup_ms` through `stage11_event_commit_ms`), ensuring complete latency attribution for future Reflex (Phase 11) optimizations.

### 14.12 Implementation Roadmap (Next Sub-Tasks)
- **Task 4.2-A**: Tool Execution Gateway Core & Boundary Interfaces (`ToolAdapterPort`, `ToolExecutionContext`, in-memory gateway tests) — *Completed in commit `3c51ab4`*.
- **Task 4.2-B**: Deterministic Workspace Tool Adapters (`read_file`, `write_file`, `search_code`, `git_status`, `git_diff`, `createWorkspaceToolAdapterRegistry`) — *Completed in commit `bfe4da8`*.
- **Task 4.2-C**: Sandboxed Command Tool Adapter & Docker Provider Mount Binding (`run_command`, `SandboxedCommandToolAdapter`, `DockerExecutionProvider`) — *Completed in commit `0209d47`*.
- **Task 4.3**: Capability Policy Mapping & Mission Contract Resource Enforcement — *Completed in current increment*.
- **Task 4.4**: Multi-Step Action Loop & WorkerRuntime Integration (`Run` $\rightarrow$ `Actions 1..N` $\rightarrow$ `VerificationSpec`).

---

## 15. Task 4.2-B Implementation Specification — Deterministic Workspace Tool Adapters

### 15.1 Bounded Operational Scope
Task 4.2-B establishes the concrete implementation of the five deterministic, workspace-contained tool adapters. External command execution (`run_command`) remains strictly deferred.

| Tool Name | Adapter Class | Execution Mode | Subprocess Invariant | Security Boundary |
| :--- | :--- | :--- | :--- | :--- |
| `read_file` | `ReadFileToolAdapter` | In-Process Node FS | Zero Subprocesses | `WorkspacePort.resolvePath()`, offset/limit line windowing, byte ceiling truncation, stable SHA-256 digest |
| `write_file` | `WriteFileToolAdapter` | In-Process Node FS | Zero Subprocesses | `WorkspacePort.resolvePath()`, atomic in-workspace staging file (`.${name}.tmp.${ts}.${rand}`) + rename, symlink target write rejection, overwrite protection |
| `search_code` | `SearchCodeToolAdapter` | In-Process Traversal | Zero Subprocesses | `WorkspacePort.resolvePath()`, deterministic sort (file ASC, line ASC), glob filter, ignores `.git`/`.emerald-workspace.json`/staging, skips binary files (null-byte probe), ReDoS mitigation |
| `git_status` | `GitStatusToolAdapter` | In-Process Git Parsing | Zero Subprocesses | Pure in-process inspection of `.git/HEAD`, `.git/index` (DIRC v2/v3), tree/loose/packed objects, scans working tree without git CLI, computes `clean`, `currentCommit`, `modified`, `added`, `deleted`, `untracked` |
| `git_diff` | `GitDiffToolAdapter` | In-Process Diff Engine | Zero Subprocesses | Pure in-process unified diff generator (Myers/LCS line edits), staged (`Index` vs `HEAD`) and unstaged (`WorkTree` vs `Index`), file/insertions/deletions counts, SHA-256 diffHash, maxBytes truncation |

### 15.2 Non-Negotiable Subprocess and Provider Invocation Ban
Under Task 4.2-B:
1. **Zero External Shell Commands**: No use of `child_process`, `exec`, `spawn`, `execSync`, `spawnSync`, `sh`, `bash`, `cmd`, or `powershell`.
2. **Zero Provider / Docker Invocations**: All five adapters execute strictly in-process within the worker daemon's contained workspace filesystem boundary. `ExecutionProvider` invocation count is strictly zero (`providerInvocationCount === 0`).
3. **Run Command Deferred**: `run_command` is explicitly excluded from `createWorkspaceToolAdapterRegistry()` unless an `ExecutionProvider` is explicitly supplied.

### 15.3 Path Containment and Privacy Invariants
1. **Dual-Boundary Enforcement**: All filesystem access delegates to `WorkspacePort.resolvePath()`, preventing symlink escapes, parent directory traversal (`..`), directory junctions, and Windows volume root escapes.
2. **Path Privacy**: Host absolute paths are never disclosed in tool outputs, error payloads, or logs. All paths returned in payloads are strictly relative to the workspace root using normalized forward slashes (`/`).

---

## 16. Task 4.2-C Implementation Specification — Sandboxed Command Tool Adapter & Docker Workspace Mount Binding

### 16.1 Bounded Operational Scope
Task 4.2-C introduces the first controlled process-execution capability: `run_command`. The implementation establishes a hardened, containerized execution pipeline with defense-in-depth isolation and strict anti-shell-injection architecture.

| Tool Name | Adapter Class | Execution Mode | Subprocess Invariant | Security Boundary |
| :--- | :--- | :--- | :--- | :--- |
| `run_command` | `SandboxedCommandToolAdapter` | Hardened Docker Container | Zero Subprocesses in Adapter | `ExecutionProvider.execute()`, Docker `--network=none`, `--read-only`, tmpfs `/tmp`, dropped capabilities, no-new-privileges, workspace mount confinement |

### 16.2 Architectural Invariants & Guarantees
1. **Zero Host Subprocess Execution**:
   - The tool adapter layer contains ZERO references to `child_process`, `exec`, `spawn`, `fork`, `sh`, `bash`, `cmd`, or `powershell`.
   - Host process execution is strictly prohibited. All process dispatch occurs exclusively through `ExecutionProvider.execute()` targeting ephemeral Docker containers.
2. **Strict Anti-Shell Injection (Discrete `argv` Tokens Only)**:
   - Command inputs are parsed and validated as discrete argument arrays (`argv: string[]`, `min(1)`).
   - Arguments are NEVER concatenated into shell strings (e.g. `"${argv.join(' ')}"`) or invoked via `/bin/sh -c` or `/bin/bash -c`.
   - Discrete tokens are passed directly to the container runtime via `--entrypoint ""` and Linux kernel `execve()`. Shell metacharacters (`;`, `|`, `&`, `>`, `$VAR`, backticks) are treated as literal arguments without interpretation.
3. **Working Directory (`cwd`) Workspace Containment**:
   - The requested `cwd` is validated against the assigned workspace sandbox using `WorkspacePort.resolvePath()`.
   - Directory traversal attempts (`../`) and absolute paths outside the workspace boundary fail closed immediately with `ToolWorkspaceBoundaryViolationError`.
   - In-container working directory is mapped relative to `/workspace` (e.g. `/workspace/${normalizedCwd}`).
4. **Pre-Execution Authorization & Governance Invariants**:
   - Authorization failures (missing capability `process.execute`, revoked MissionContract, requested ceilings exceeding contract limits, invalid schema) fail closed before execution dispatch.
   - For all pre-execution failures, `providerInvocationCount === 0` is strictly guaranteed.
5. **Non-Clamping Resource Ceilings**:
   - Requests exceeding contract ceilings are rejected, never silently clamped.
   - Execution timeout (`timeoutMs`) and output volume (`maxOutputBytes`) are strictly bounded by `ToolExecutionContext.resourceLimits`.
6. **Container Security & Confinement**:
   - Network isolation: `--network=none` disabled entirely.
   - Root filesystem: `--read-only` rootfs prevents modification of system binaries or libraries.
   - Temporary storage: `--tmpfs=/tmp:rw,noexec,nosuid,size=64m`.
   - Privilege mitigation: `--cap-drop=ALL` and `--security-opt=no-new-privileges`.
   - Workspace mount: `-v ${hostPath}:/workspace:rw` confines filesystem mutations strictly to the active workspace.
   - Docker daemon socket (`/var/run/docker.sock`) is strictly inaccessible.
7. **Fail-Closed Provider Policy**:
   - If Docker is unavailable or the daemon cannot be reached, the adapter fails closed with `TOOL_PROVIDER_UNAVAILABLE`. Host process downgrade is strictly forbidden.
8. **Deterministic Output & Error Taxonomy**:
   - Non-zero command exit codes (e.g. `exitCode: 1`) are captured as valid command results with full stdout and stderr preserved.
   - Failures map to deterministic domain errors: `ToolTimeoutError`, `ToolOutputLimitExceededError`, `ToolCancelledError`, `ToolProviderUnavailableError`, `ToolExecutionFailedError`.
   - Output includes deterministic SHA-256 `commandHash` computed over the canonical discrete arguments.

---

## 17. Task 4.3 Implementation Specification — Capability Policy Mapping & Mission Contract Resource Enforcement

### 17.1 Capability Policy Authorization Model
Capability authorization enforces explicit, deterministic mapping between typed tools and Mission Contract execution policies:

| Tool Name | Required Capability | Policy Evaluation Rule | Fail-Closed Error |
| :--- | :--- | :--- | :--- |
| `read_file` | `workspace.file.read` | Evaluated against `MissionContract.spec.policy.allowedCapabilities` | `ToolCapabilityDeniedError` (`CAPABILITY_DENIED`) |
| `write_file` | `workspace.file.write` | Evaluated against `MissionContract.spec.policy.allowedCapabilities` | `ToolCapabilityDeniedError` (`CAPABILITY_DENIED`) |
| `search_code` | `workspace.code.search` | Evaluated against `MissionContract.spec.policy.allowedCapabilities` | `ToolCapabilityDeniedError` (`CAPABILITY_DENIED`) |
| `git_status` | `git.read` | Evaluated against `MissionContract.spec.policy.allowedCapabilities` | `ToolCapabilityDeniedError` (`CAPABILITY_DENIED`) |
| `git_diff` | `git.read` | Evaluated against `MissionContract.spec.policy.allowedCapabilities` | `ToolCapabilityDeniedError` (`CAPABILITY_DENIED`) |
| `run_command` | `process.execute` | Evaluated against `MissionContract.spec.policy.allowedCapabilities` | `ToolCapabilityDeniedError` (`CAPABILITY_DENIED`) |

**Security Invariants**:
1. **Explicit Grant Required**: Any capability not explicitly present in `allowedCapabilities` is DENIED (deny-by-default).
2. **Zero Wildcards**: Wildcard patterns (`*`) or dynamic privilege escalation are strictly forbidden and rejected.
3. **Untrusted Request Boundary**: Tool inputs cannot grant or alter capabilities (e.g. injecting `"capability"` into request payload is ignored during authorization and rejected by schema validation). Authoritative capability is derived strictly from the immutable `ToolDefinition`.
4. **Malformed Policy Defense**: If `allowedCapabilities` is missing or contains non-strings, or if `isolationRequirement` is unrecognized, evaluation fails closed with `INVALID_POLICY`.

### 17.2 Exact Mission Contract Binding Invariants
Tool execution evaluates authority strictly against the exact Mission Contract bound to the active Run:
- **Binding Identity**: `(contractId, version, contentHash)` must match the Run's persisted `contractBinding`. Dynamic resolution of "latest" or "active" contracts during tool dispatch is forbidden.
- **Content Hash Verification**: Recomputes SHA-256 canonical hash over `MissionContract.spec` to verify zero tampering.
- **Task Association**: Contract `taskId` must match the Run's `taskId`.
- **Active Lifecycle Status**: Contract status must be `ACTIVE`. If `REVOKED`, dispatch fails closed immediately with `ContractRevokedError` (`CONTRACT_REVOKED`); if `DRAFT`, fails with `ContractNotActiveError`.

### 17.3 Non-Clamping Resource Authority Invariant
Resource limits requested in tool payloads are evaluated against authoritative Mission Contract ceilings before adapter dispatch:
```text
Mission Contract ceiling
        ↓
requested operational value
        │
        ├── requested > ceiling ────► REJECT (ResourceLimitExceededError ──► ZERO Execution)
        │
        └── requested <= ceiling ───► ACCEPT (effective = min(requested, default/safetyLimit))
```
- **Strict Non-Clamping Rule**: Requests exceeding contract ceilings are rejected, never silently clamped to authorized values. Clamping unauthorized requests conceals governance violations and is strictly forbidden.
- **Dimensions Enforced**:
  - `timeoutMs`: `requested <= contract.spec.resourceLimits.timeoutMs`
  - `maxOutputBytes`: `requested <= contract.spec.resourceLimits.maxOutputBytes`
  - `maxBytes`: `requested <= contract.spec.resourceLimits.maxOutputBytes` (for `read_file`, `write_file`, `search_code`, `git_diff`)
  - `write_file` payload bytes: `contentBytes <= contract.spec.resourceLimits.maxOutputBytes`

### 17.4 Separation of Contract Ceilings vs Provider Physical Safety Limits
- **Mission Contract Authorization**: Answers *"Is this requested operation authorized for this mission?"*
- **Provider Safety Limits**: Answers *"What is physically safe for this execution environment?"*
- **Relationship**: `requested <= contract ceiling` is necessary for authorization. Lower provider safety limits (e.g. Docker daemon memory/CPU/PIDs limits or maximum output truncation buffers) may narrow an authorized request during physical execution, but can never legitimize an unauthorized request that exceeded contract limits.

### 17.5 Mandatory Zero-Execution Invariant on Governance Failure
For all governance rejections:
- `CAPABILITY_DENIED`
- `RESOURCE_LIMIT_EXCEEDED`
- `CONTRACT_REVOKED`
- `CONTRACT_INTEGRITY_FAILURE`
- `CONTRACT_ASSOCIATION_FAILURE`
- `INVALID_RUN`
- `LEASE_LOST`

The ExecutionProvider invocation count is strictly zero (`providerInvocationCount === 0`). Physical adapter and container execution never occur on unauthorized requests.

---

## 18. Task 4.4-B Implementation Specification — Action & Attempt Pure Domain Contracts & Invariants

### 18.1 Semantic Separation: Logical Intention vs Physical Execution Trial
Task 4.4-B introduces the pure domain models distinguishing **Action** from **Attempt**:

$$\text{Action} \ne \text{Attempt}$$

- **Action (Logical Intention)**: Represents one discrete operation intended by the reasoning agent (e.g. `run_command` with `argv: ["npm", "test"]`). It encapsulates the validated input, canonical `inputHash`, monotonic sequence number per Run ($1..N$), immutable contract authority binding, and aggregate outcome across retries.
- **Attempt (Physical Trial)**: Represents one concrete execution try of an Action. It is bound to an active worker lease (`workerId`, `leaseId`), carries a unique deterministic `idempotencyToken` (`${runId}:${actionId}:${attemptNumber}`), and captures physical execution metadata, duration, exit code, and evidence produced.

### 18.2 Invariants & Cardinality
1. **$1..N$ Relationship**: An Action may have 0 attempts upon creation, 1 attempt in standard execution, or multiple attempts ($N$) during bounded retries.
2. **Strictly Serial Execution per Run**: Exactly one Action may be active (`RUNNING` or `RETRYING`) per Run at a time, and an Action may have at most one active Attempt. Concurrent execution within the same workspace is prohibited to prevent filesystem race conditions and Git index corruption.
3. **Immutability of Intent**: Intent fields (`actionId`, `runId`, `sequenceNumber`, `toolName`, `inputPayload`, `inputHash`, `idempotency`, `contractBinding`, `maxAttempts`, `createdAt`) are frozen upon Action creation. Only lifecycle states and result fields mutate through pure deterministic transitions.
4. **Attempt Single-Shot Semantics**: An Attempt cannot be retried or resumed. Once an Attempt terminates (`SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `UNKNOWN`), its state is final. Retrying an Action creates a fresh Attempt ($N+1$).

### 18.3 Critical UNKNOWN Semantics & Fail-Closed Defense
- **Definition**: The `UNKNOWN` state represents **execution uncertainty** during crash windows (e.g., worker crashes or lease expires while container execution or filesystem writes were in-flight).
- **Semantics**:
  - `UNKNOWN` does NOT mean `FAILED`.
  - `UNKNOWN` does NOT mean `SUCCEEDED`.
  - `UNKNOWN` does NOT imply side effects did not occur.
  - `UNKNOWN` is strictly terminal. An Attempt in `UNKNOWN` cannot transition to `RUNNING`, `SUCCEEDED`, or `FAILED`.
- **Fail-Closed Idempotency Rule**:
  - **NON_IDEMPOTENT tools (`write_file`, `run_command`)**: If an attempt outcome is `UNKNOWN`, the system **MUST FAIL CLOSED** (`NON_IDEMPOTENT_UNKNOWN`). Automated retry is strictly prohibited because unobserved destructive side effects may have occurred. Recovery requires explicit workspace reclamation or rollback.
  - **IDEMPOTENT tools (`read_file`, `search_code`, `git_status`, `git_diff`)**: Read-only queries leave no side effects and are potentially eligible for retry across crashes, bounded by `maxAttempts`.

### 18.4 Ownership and Pure Domain Boundary
1. **Retry Ownership**: Authoritative retry decisions belong exclusively to top-level orchestration (`WorkerRuntime` / Action Controller). Lower layers (tool adapters, `WorkspacePort`, `ExecutionProvider`) are forbidden from autonomous retries.
2. **Lease Ownership**: Every Attempt carries explicit execution context (`workerId`, `leaseId`). Physical execution and state mutations require active lease ownership.
3. **Pure Domain Boundary**: The Action and Attempt domain layer contains ZERO calls to Docker, ExecutionProvider, child processes, filesystem I/O, or SQLite persistence. Invariants are pure, deterministic, and testable in memory.

---

## 19. Task 4.4-C Implementation Specification — Action & Attempt State Machines & Domain Events

### 19.1 Authoritative Domain Event Vocabulary

Task 4.4-C establishes the strongly typed domain events for the Action and Attempt lifecycles. Every legal state transition produces exactly one immutable domain event conforming to the foundational `DomainEvent<TPayload>` contract.

#### 19.1.1 Action Domain Events (`producer: "domain.action_aggregate"`, `schemaVersion: 1`)
- **`action.created`**: Emitted upon Action creation. Payload captures frozen logical intent:
  - `actionId`, `runId`, `sequenceNumber`, `toolName`, `inputHash`, `idempotency`, `contractBinding`, `maxAttempts`.
  - *Payload Safety Ceilings*: The event payload records the SHA-256 canonical `inputHash` and strictly excludes the raw `inputPayload` to prevent multi-megabyte blowup of the audit trail.
- **`action.authorized`**: Emitted when governance stages (Mission Contract, capability policy, and non-clamping resource ceilings) authorize the Action:
  - `actionId`, `runId`, `sequenceNumber`, `toolName`.
- **`action.started`**: Emitted when a physical trial starts executing for this Action:
  - `actionId`, `runId`, `attemptNumber`.
- **`action.completed`**: Emitted upon successful completion of the Action (passing tool output validation and deterministic post-condition verification):
  - `actionId`, `runId`, `totalAttempts`, `resultPayload`.
- **`action.failed`**: Emitted upon terminal failure of the Action (unauthorized, retries exhausted, non-idempotent failure, or terminal error):
  - `actionId`, `runId`, `totalAttempts`, `error`.
- **`action.timed_out`**: Emitted when cumulative action execution deadline expires:
  - `actionId`, `runId`, `totalAttempts`, `reason`.
- **`action.cancelled`**: Emitted when execution is aborted prior to or during execution:
  - `actionId`, `runId`, `reason`.
- **`action.retrying`**: Emitted when an attempt fails and the Action prepares for a subsequent trial:
  - `actionId`, `runId`, `attemptNumber`, `nextAttemptNumber`, `maxAttempts`, `error`.

#### 19.1.2 Attempt Domain Events (`producer: "domain.attempt_aggregate"`, `schemaVersion: 1`)
- **`attempt.created`**: Emitted when a physical execution instance is initialized:
  - `attemptId`, `actionId`, `runId`, `attemptNumber`, `workerId`, `leaseId`, `idempotencyToken`.
- **`attempt.dispatched`**: Emitted when the attempt is dispatched to the tool adapter / provider:
  - `attemptId`, `actionId`, `runId`, `attemptNumber`, `workerId`, `leaseId`.
- **`attempt.started`**: Emitted when physical execution begins (e.g. Docker container launched):
  - `attemptId`, `actionId`, `runId`, `attemptNumber`.
- **`attempt.completed`**: Emitted when the physical trial exits with zero exit code and validated output:
  - `attemptId`, `actionId`, `runId`, `attemptNumber`, `exitCode`, `durationMs`, `evidenceIds`.
- **`attempt.failed`**: Emitted when the physical trial exits with non-zero exit code or adapter error:
  - `attemptId`, `actionId`, `runId`, `attemptNumber`, `exitCode`, `durationMs`, `evidenceIds`, `error`.
- **`attempt.timed_out`**: Emitted when attempt wall-clock duration exceeds allocated budget:
  - `attemptId`, `actionId`, `runId`, `attemptNumber`, `durationMs`, `reason`.
- **`attempt.cancelled`**: Emitted when the attempt is aborted or worker preempted:
  - `attemptId`, `actionId`, `runId`, `attemptNumber`, `reason`.
- **`attempt.unknown`**: Emitted when execution outcome is indeterminate due to worker crash, lease expiry, or unobserved termination:
  - `attemptId`, `actionId`, `runId`, `attemptNumber`, `reasonCode`, `details`.

### 19.2 Critical UNKNOWN Semantics & Reason Code Taxonomy
The `AttemptUnknownReason` closed enum captures physical execution uncertainty:
```ts
export type AttemptUnknownReason =
  | "LEASE_EXPIRED_DURING_EXECUTION"
  | "WORKER_CRASHED"
  | "PROCESS_TERMINATION_BEFORE_PERSISTENCE"
  | "PROVIDER_RESULT_UNAVAILABLE"
  | "UNSPECIFIED_EXECUTION_UNCERTAINTY";
```
- **Execution Uncertainty Defense**: An event carrying `attempt.unknown` explicitly signals that container or process side effects may have executed without observation.
- For `NON_IDEMPOTENT` operations (`write_file`, `run_command`), receiving `attempt.unknown` permanently triggers fail-closed execution termination (`NON_IDEMPOTENT_UNKNOWN`). Automated retries are strictly prohibited.

### 19.3 Causal Ordering & Aggregate Invariants
The causal relationship between Action and Attempt events follows a deterministic sequence:

```text
Action Created     (action.created)
      ↓
Action Authorized  (action.authorized)
      ↓
Attempt 1 Created  (attempt.created [runId:actId:1])
      ↓
Action Started     (action.started [attempt 1])
      ↓
Attempt 1 Disp.    (attempt.dispatched)
      ↓
Attempt 1 Exec.    (attempt.started)
      ↓
Attempt 1 Failed   (attempt.failed [exitCode: 1])
      ↓
Action Retrying    (action.retrying [attempt 1 -> 2])
      ↓
Attempt 2 Created  (attempt.created [runId:actId:2])
      ↓
Action Started     (action.started [attempt 2])
      ↓
Attempt 2 Disp.    (attempt.dispatched)
      ↓
Attempt 2 Exec.    (attempt.started)
      ↓
Attempt 2 Succeeded(attempt.completed [exitCode: 0, durationMs: 40])
      ↓
Action Completed   (action.completed [totalAttempts: 2])
```

- **Strict Identity Invariance**: Across all attempts, `actionId` and `sequenceNumber` remain immutable.
- **Idempotency Token Uniqueness**: Each Attempt trial receives a distinct, deterministic `idempotencyToken` (`${runId}:${actionId}:${attemptNumber}`), preventing stale result caching or duplicate physical invocation.

### 19.4 Operational State vs Event History Separation
In accordance with Emerald Architecture Principle:
$$\text{Operational State} \ne \text{Event History}$$
1. **Durable Tables Own Operational Authority**: Authoritative lifecycle state lives in ACID SQLite tables (`runs`, `leases`, `actions`, `attempts`).
2. **Events Are Immutable Fact Records**: Domain events represent immutable facts describing state transitions that were accepted and validated by domain invariant engines.
3. **Sequence Numbering Ownership**: Domain events do NOT include monotonic database log sequence numbers (`sequence`); global monotonically increasing event log sequences are assigned exclusively by SQLite transactions in `run_events` during atomic persistence (deferred to Task 4.4-D).

