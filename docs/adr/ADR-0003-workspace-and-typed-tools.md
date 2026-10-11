# ADR-0003: Workspace Sandbox Boundary and Typed Tool System Architecture

## Status
Approved

## Date
2026-10-11

## Governing Documents
- [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- [ADR-0001: Master Engineering Constitution](./ADR-0001-master-engineering-constitution.md)
- [ADR-0002: Runtime Kernel, Durable State Machine, Leased Worker Coordination, and Append-Only Event Store](./ADR-0002-runtime-kernel-and-durable-state-machine.md)
- [Workspace Sandbox Architecture](../architecture/workspace-sandbox.md)
- [Typed Tool System Architecture](../architecture/typed-tools.md)
- [Security Architecture](../architecture/security.md)
- [Runtime Architecture](../architecture/runtime.md)

---

## 1. Context & Problem Statement

In Capability 1 (Tasks 1.1–1.8C), Emerald established a deterministic, crash-recoverable execution runtime. In this foundation:
1. Operational transitions are strictly atomic and serialized via Optimistic Concurrency Control in SQLite WAL mode.
2. Background execution is protected by lease fencing and fail-closed crash recovery.
3. Cryptographic Mission Contracts govern authorization, clamping operational resources, timeouts, and capabilities.
4. Deterministic evidence and verification prove execution fidelity without human claims.

However, execution is currently restricted to four toy mathematical primitives (`execution.echo`, `execution.sum`, `execution.slow`, `execution.fail`) dispatched as a single monolithic execution payload per `Run`. Containers execute with an ephemeral in-memory tmpfs (`--tmpfs /tmp:rw,noexec,nosuid,size=64m`) and zero host filesystem mounts.

To enable autonomous software engineering agents to operate on real software systems, the fabric requires two interrelated capabilities:
- **Phase 3 (Workspace Sandbox)**: An isolated, bounded filesystem environment where software repositories are cloned, inspected, modified, built, and tested at immutable revisions without exposing host files or leaking secrets.
- **Phase 4 (Typed Tool System)**: A suite of narrow, typed, permission-gated, observable tools (`read_file`, `write_file`, `search_code`, `git_status`, `git_diff`, `run_command`) executed in multi-step sequences under strict capability policies derived from the governing Mission Contract.

Exposing real filesystem and execution capabilities to untrusted agent code or LLMs introduces severe architectural and security risks:
- Path traversal escapes (`../../etc/passwd`, nested symlinks pointing outside the sandbox).
- Arbitrary command injection and shell breakout.
- Cross-run state contamination.
- Unbounded disk, memory, or CPU resource exhaustion.
- Bypassing the immutable Mission Contract governance boundary.
- Non-deterministic and un-replayable side effects.

This architecture decision record establishes the architectural design for the Workspace Sandbox and Typed Tool System.

---

## 2. Alternatives Considered

We evaluated four architectural alternatives for the Workspace Sandbox and Typed Tool System.

### Alternative A: Direct Execution in Docker Without Tool Registry or Typed Boundary
In this approach, the runtime passes untyped commands (or raw shell scripts) directly to `DockerExecutionProvider`. The agent emits arbitrary shell strings (`bash -c "..."`), and the container executes them directly against a mounted directory.

- **Pros**:
  - Simplest to implement initially.
  - Zero schema validation overhead for individual tools.
- **Cons & Rejection Rationale**:
  - **Fatal Security Vulnerability**: Shell interpolation enables trivial prompt injection escapes and arbitrary command execution.
  - **Zero Fine-Grained Authorization**: The runtime cannot enforce read-only vs write permissions or restrict git operations without inspecting arbitrary bash strings.
  - **Zero Testability**: Unit tests cannot mock individual file reads or git queries without spinning up Docker containers and executing shell commands.
  - **Violates Constitution Section 11**: Constitution explicitly mandates narrow, typed, observable tools and prohibits raw shell wrappers.
- **Verdict**: **Rejected**.

### Alternative B: Tool Execution Gateway Without Workspace Isolation Layer
In this approach, typed tools (`read_file`, `write_file`, `search_code`) are executed by a gateway directly on the host filesystem (e.g. within a temporary folder created on the host by Node.js `fs.mkdtemp`), but processes and builds run uncontained without Docker or cgroup isolation.

- **Pros**:
  - Fast execution without container startup latency.
  - Bounded memory footprint for simple file manipulation tasks.
- **Cons & Rejection Rationale**:
  - **Inadequate Process Containment**: Running build tools (`npm test`, `pytest`, `cargo build`) on the host allows untrusted code in repositories to access host network, environment variables, and credentials.
  - **Host Filesystem Contamination**: A malicious or bug-ridden script can easily escape the host folder via standard system calls.
  - **Violates Constitution Section 10**: Hard physical execution boundaries must be enforced by container cgroups and namespaces.
- **Verdict**: **Rejected**.

### Alternative C: Workspace Manager Without Fine-Grained Tool Registry
In this approach, an isolated workspace is provisioned and mounted into Docker containers, but the agent interacts with it using a monolithic, untyped "execute" port rather than distinct typed tools. Tools are treated merely as command-line arguments to a single container execution.

- **Pros**:
  - Reuses the existing single-step `ExecutionProvider` interface without expanding domain ports.
- **Cons & Rejection Rationale**:
  - **No Typed Domain Contracts**: Responses from file reads, git diffs, and searches are returned as unstructured stdout strings, forcing callers to parse stdout and risk truncation or decoding errors.
  - **Coarse Capability Enforcement**: Capability checks can only check "execute", losing the ability to authorize `workspace.file.read` while denying `process.execute`.
  - **Poor Observability**: The append-only event stream records opaque command executions rather than discrete semantic events (`tool.read_file.invoked`, `tool.write_file.completed`).
- **Verdict**: **Rejected**.

### Alternative D: Modular Hexagonal Architecture: Tool Registry + Capability Policy Engine + Workspace Manager + Tool Execution Gateway + ExecutionProvider (Selected)
In this approach, the runtime establishes a fully decoupled, hexagonal boundary:
1. **`WorkspaceManager` (Phase 3)**: Manages workspace directory provisioning, repository acquisition at immutable commit SHAs, canonical path sanitization, quota enforcement, container volume binding, and fail-closed sweeper cleanup.
2. **`ToolRegistry` (Phase 4)**: Declares immutable, typed Zod schemas for inputs, outputs, errors, and metadata for every tool primitive (`read_file`, `write_file`, `search_code`, `git_status`, `git_diff`, `run_command`).
3. **`PolicyEvaluator` (Inherited from 1.8C)**: Evaluates whether the governing `MissionContract` explicitly authorizes the tool's required capability string (`workspace.file.read`, `workspace.file.write`, `workspace.code.search`, `git.read`, `process.execute`) prior to execution.
4. **`ToolExecutionGateway` (Phase 4)**: Mediates the multi-step action lifecycle (`Run` $\rightarrow$ `Execution` $\rightarrow$ `Action` $\rightarrow$ `Attempt`), validates schemas, enforces parameter bounds, canonicalizes paths, records audit events, measures execution time, and captures canonical cryptographic evidence.
5. **`ExecutionProvider` (Inherited & Extended)**: Executes containerized actions in non-root Docker containers with read-only root filesystems, dropped Linux capabilities, no-new-privileges flags, memory/CPU cgroup limits, and strict workspace volume mounts.

- **Pros**:
  - **Strict Hexagonal Separation**: Domain logic has zero dependencies on Node.js `fs` or Docker CLI.
  - **Fail-Closed Security**: Policy authorization, path sanitization, and schema validation fail closed before touching disk or launching processes.
  - **Independent Testability**: Every tool can be tested with in-memory workspace mocks; the workspace manager can be tested without Docker; Docker integration can be tested with synthetic repositories.
  - **Preserves Frozen 1.8C Invariants**: The Mission Contract aggregate and persistence layers remain 100% frozen and unmodified.
- **Verdict**: **Selected**.

---

## 3. Decision

We formally adopt **Alternative D** as the architectural foundation for Phase 3 (Workspace Sandbox) and Phase 4 (Typed Tool System).

### 3.1 Hexagonal Architecture & Inward Dependency Model

The architecture enforces strict inward dependencies adhering to Constitution Section 4:

```text
Adapters (External)              Application (Coordination)        Domain (Pure Logic)
-------------------              --------------------------        -------------------
NodeFsWorkspaceAdapter    --->   WorkspaceManager           --->   WorkspacePort (Port)
GitCliRepositoryAdapter   --->   ToolExecutionGateway       --->   ToolDefinition (Contract)
DockerExecutionProvider   --->   WorkerRuntime              --->   PolicyEvaluator (Domain)
SqliteStateStore          --->   RunCoordinator             --->   MissionContract (Frozen)
```

1. **Domain Layer**:
   - Contains pure schemas, value objects, and business rules: `ToolName`, `ToolInput`, `ToolOutput`, `ToolError`, `ToolDefinition`, `ToolCapabilityMap`, `ActionAttempt`, `WorkspaceLease`.
   - Pure path resolution and sanitization rules (`sanitizeWorkspacePath`).
   - Domain capability definitions (`workspace.file.read`, `workspace.file.write`, `workspace.code.search`, `git.read`, `process.execute`).
   - Depends on **zero** external libraries except schema validators (Zod) and crypto primitives.

2. **Ports Layer**:
   - `WorkspacePort`: Defines the lifecycle contract for provisioning, leasing, path verification, and disposing workspaces.
   - `ToolRegistryPort`: Defines registration, lookup, and schema inspection for tools.
   - `ToolExecutionPort`: Defines the execution interface for dispatching typed actions.
   - `RepositoryAcquisitionPort`: Defines repository cloning and checkout at immutable revisions.

3. **Application Layer**:
   - `WorkspaceManager`: Orchestrates workspace provisioning, quota enforcement, and sweeper cleanup.
   - `ToolExecutionGateway`: Coordinates the 9-stage execution pipeline (Resolve Tool $\rightarrow$ Check Policy $\rightarrow$ Check Contract Status $\rightarrow$ Validate Input Schema $\rightarrow$ Validate Workspace Boundary $\rightarrow$ Execute Tool $\rightarrow$ Validate Output Schema $\rightarrow$ Record Audit Event $\rightarrow$ Capture Canonical Evidence).
   - `WorkerRuntime`: Drives the multi-step execution loop while holding the active worker lease.

4. **Adapters Layer**:
   - `NodeFsWorkspaceAdapter`: Implements `WorkspacePort` using Node.js `fs/promises` and realpath verification.
   - `GitCliRepositoryAdapter`: Implements `RepositoryAcquisitionPort` via local Git commands.
   - `DockerExecutionProvider`: Implements process isolation via container runs with mounted workspace volumes.

### 3.2 Preservation of Frozen Mission Contract Invariants (1.8C)

Task 1.8C established cryptographic Mission Contract governance. **The Mission Contract schema and persistence models remain completely frozen.**

The Typed Tool System integrates with Mission Contract governance through existing, forward-compatible domain mechanisms:
1. **Capability Authorization**:
   - Each tool maps deterministically to a domain capability string:
     - `read_file` $\rightarrow$ `workspace.file.read`
     - `write_file` $\rightarrow$ `workspace.file.write`
     - `search_code` $\rightarrow$ `workspace.code.search`
     - `git_status` $\rightarrow$ `git.read`
     - `git_diff` $\rightarrow$ `git.read`
     - `run_command` $\rightarrow$ `process.execute`
   - Before any tool invocation, `PolicyEvaluator.evaluate()` checks the cached `MissionContract.spec.capabilities`. If the required capability is absent or denied, execution fails immediately with `CAPABILITY_DENIED` and error code `FORBIDDEN`.
2. **Resource Clamping**:
   - The tool system clamps its operational limits to the contract:
     - `timeout_ms` = $\min(\text{tool\_requested\_timeout}, \text{contract.spec.resourceLimits.maxExecutionTimeoutMs})$.
     - Output size = $\min(\text{tool\_requested\_output}, \text{contract.spec.resourceLimits.maxOutputSizeBytes})$.
     - Disk quota = $\min(\text{workspace\_requested\_bytes}, \text{contract.spec.resourceLimits.maxDiskBytes} \text{ [default 1GB]})$.
3. **Revocation Semantics**:
   - Between every action step in a multi-step Run, the `WorkerRuntime` verifies the active contract status. If the contract has been revoked (`REVOKED`), the runtime terminates execution immediately with `CONTRACT_REVOKED`, tears down the workspace, and marks the Run `FAILED`.

### 3.3 Multi-Step Execution Model: Run $\rightarrow$ Execution $\rightarrow$ Action $\rightarrow$ Attempt

To support iterative coding workflows without destabilizing the frozen `Run` state machine, Emerald introduces a hierarchical execution model:

```text
Run (Durable Aggregate)
 └── Status: RUNNING (State machine invariant preserved)
      └── Execution (Worker Session under Lease)
           ├── Action 1: read_file (Completed)
           │    └── Attempt 1 (Succeeded, Evidence Captured)
           ├── Action 2: search_code (Completed)
           │    └── Attempt 1 (Succeeded, Evidence Captured)
           ├── Action 3: write_file (Completed)
           │    └── Attempt 1 (Succeeded, Evidence Captured)
           └── Action 4: run_command (In Progress)
                ├── Attempt 1 (Timed out, Transient Error)
                └── Attempt 2 (Succeeded, Evidence Captured)
```

1. **State Machine Invariant**: The `Run` remains in status `RUNNING` from worker dispatch until the entire sequence completes, fails, or times out. No fine-grained action states pollute the top-level FSM.
2. **Action Identity & Sequence**: Every action has a deterministic sequence number ($1, 2, \dots, N$) per Run, providing gapless event ordering.
3. **Attempt & Retry Semantics**:
   - Transient failures (e.g. process lock contention, momentary I/O delay) may be retried up to `max_attempts` per action.
   - Deterministic domain failures (e.g. `INVALID_INPUT`, `PATH_TRAVERSAL`, `CAPABILITY_DENIED`) fail closed immediately with zero retries.
4. **Failure Propagation**:
   - If an action fails with a non-retryable error, the `Run` transitions to `FAILED`.
   - If an action exceeds its attempt limit, the `Run` transitions to `FAILED`.
   - If total wall-clock duration exceeds the run timeout, the `Run` transitions to `TIMED_OUT`.

---

## 4. Security Threat Model Summary (30 Threat Vectors)

The architecture specification documents a comprehensive 30-point threat model categorized into five primary security domains. Alternative D provides multi-layered defenses for each vector:

| ID | Threat Vector | Primary Defense Mechanism |
|:---|:---|:---|
| **T01** | Relative path traversal (`../../etc/passwd`) | Lexical normalization + root prefix verification via `path.resolve` and strict prefix match. |
| **T02** | Symlink traversal escape | Realpath canonicalization (`fs.realpath`) verifying real path resides inside real workspace root before every read/write. |
| **T03** | Absolute path injection (`/etc/shadow`) | Rejection of absolute paths or strict re-rooting under `/workspace`. |
| **T04** | Symlink race condition (TOCTOU) | Directory-pinned operations, atomicity checks, or in-container execution under container namespace. |
| **T05** | Null byte injection (`file.txt\0.js`) | Rejection of paths containing `\0` in Zod schema and path sanitizer. |
| **T06** | Hidden/Sensitive file exposure (`.git`, `.env`) | Blocklist blocking access to `.git/config`, `.git/hooks`, `.env*`, and credential stores. |
| **T07** | Disk exhaustion via giant file write | Pre-write size check + streaming byte counter throwing `QUOTA_EXCEEDED` if file size exceeds limit. |
| **T08** | Inode exhaustion via million file creation | Workspace directory quota checking file count limits before creation. |
| **T09** | Memory exhaustion via giant read | `read_file` size guard checking `fs.stat` size before reading; streaming chunk limits. |
| **T10** | Regex/Search CPU exhaustion (ReDoS) | Fixed search timeout (30s) + literal search default + bounded ripgrep execution. |
| **T11** | Unbounded output buffer (Stdout bomb) | Output stream truncation at `maxOutputSizeBytes` with `truncated: true` flag. |
| **T12** | Fork bomb in `run_command` | Docker container `--pids-limit 128` preventing runaway process creation. |
| **T13** | Shell injection via parameter interpolation | Direct `execFile` array arguments; zero shell (`bash -c`) wrapping of user parameters. |
| **T14** | Command substitution (backticks, `$()`) | Executed via argv vector without shell parsing; command strings never evaluated by shell. |
| **T15** | Environment variable credential leakage | Clean environment whitelist; all host env vars (`AWS_*`, `GITHUB_*`, `SSH_*`) stripped. |
| **T16** | Container breakout via privilege escalation | `--security-opt no-new-privileges:true` + `--cap-drop ALL` + non-root user (`uid 10001`). |
| **T17** | Host mount escape | Workspace mounted as isolated subvolume; host root (`/`) never mounted; container rootfs `--read-only`. |
| **T18** | Outbound network exfiltration | `--network none` in container by default unless `network.outbound` capability explicitly authorized. |
| **T19** | Concurrent write race condition | Single active worker lease per Run; optimistic concurrency control on state mutations. |
| **T20** | Partial write corruption on crash | Write-to-temp-file and atomic rename (`fs.rename`) within same filesystem. |
| **T21** | Stale worker writing to disposed workspace | Worker lease fencing token verified before workspace operations; disposed workspace directory unlinked. |
| **T22** | Uncommitted git state collision | Dedicated workspace per Run; zero workspace sharing across distinct Runs. |
| **T23** | Git hook execution vulnerability | Repository acquisition strips or disables `.git/hooks`; `git -c core.hooksPath=/dev/null` enforced. |
| **T24** | Malicious `.gitmodules` / submodule injection | Submodule recursion disabled by default (`--no-recurse-submodules`); submodules require explicit capability. |
| **T25** | Unchecked capability escalation | Capability Policy Engine checks `PolicyEvaluator.evaluate()` before every single action. |
| **T26** | Mission Contract revocation bypass | Status check against `MissionContract` before each action; revocation triggers immediate abort. |
| **T27** | Tampering with audit logs | Append-only event store (`run_events`) committed in SQLite transaction; sequence numbers gapless. |
| **T28** | Fabricated execution evidence | Evidence payload cryptographically hashed (`SHA-256`) and signed/verified by `DeterministicVerifier`. |
| **T29** | Worker crash leaving orphaned storage | Lease sweeper reclaims expired leases and invokes `WorkspaceManager.cleanupOrphaned()`. |
| **T30** | Stale lease handover writing to new run | Disposed workspace has unique UUID path; new run receives freshly provisioned directory. |

---

## 5. Implementation Sequencing & Roadmap

To ensure low cognitive overhead, zero regression, and strict compliance with the Master Engineering Constitution, implementation is partitioned into two distinct, sequential phases:

```text
Phase 3: Workspace Sandbox & Filesystem Isolation
 ├── Task 3.1: Domain Models, Ports, Path Sanitizer, & Workspace Lifecycle Events
 ├── Task 3.2: Local Filesystem Workspace Adapter & Path Canonicalization
 ├── Task 3.3: Docker Execution Provider Volume Mounting & Container Hardening
 └── Task 3.4: Sweeper Crash Recovery Integration & Orphaned Workspace Cleanup
      │
      ▼
Phase 4: Typed Tool System & Multi-Step Execution
 ├── Task 4.1: Tool Domain Contracts, Schemas, & Error Taxonomy
 ├── Task 4.2: In-Memory / Local Tool Adapter Implementation (6 Core Tools)
 ├── Task 4.3: Capability Policy Mapping & Contract Clamping
 ├── Task 4.4: Tool Execution Gateway & WorkerRuntime Multi-Step Action Loop
 └── Task 4.5: Deterministic Evidence Recording & Verification Binding
```

### Sequencing Constraints:
1. **Phase 3 MUST precede Phase 4**: Typed tools cannot operate safely until the isolated workspace boundary and path sanitization mechanisms exist.
2. **Every sub-task must be independently committed and verified**: Tests must pass with zero TypeScript errors at every intermediate milestone.
3. **Mission Contract governance (1.8C) remains frozen**: No task may alter `MissionContract` domain entities, SQLite schema, or persistence logic.

---

## 6. Consequences

### Positive
- **Rock-Solid Security**: Dual-boundary protection (in-process path sanitization + out-of-process container volume isolation) guarantees zero host contamination.
- **Fail-Closed Governance**: Every action is cryptographically anchored to a Mission Contract and evaluated against capability policies.
- **High Testability**: Decoupled ports permit comprehensive testing with fast in-memory mocks without Docker daemons or live git repositories.
- **Multi-Step Agility**: Autonomous agents can perform complex iterative workflows without requiring changes to the core `Run` finite state machine.
- **Crash Durability**: Sweepers safely recover orphaned workspaces, eliminating disk leaks on developer machines.

### Negative & Trade-Offs
- **Disk I/O Overhead**: Provisioning fresh workspace directories per Run requires disk space and setup time (mitigated via lightweight directory templates or local git caches).
- **Schema Rigidity**: Adding a new tool primitive requires defining a formal Zod schema, capability mapping, and adapter implementation rather than writing an ad-hoc shell script.
- **Container Volume Mounting Latency**: Docker container startup and volume initialization adds 200–500ms per container dispatch compared to raw in-process execution.

---

## 7. Revisit Conditions

This architectural decision must be formally reviewed and updated via a subsequent ADR if:
1. Multi-tenant cloud deployment requires hardware-level microVMs (Firecracker, Kata Containers, gVisor) instead of local Docker container isolation.
2. Distributed agent coordination requires remote workspace synchronization (e.g. S3 snapshotting or network block storage) across distinct physical worker nodes.
3. Interactive human-in-the-loop approvals are introduced, requiring suspended/resumed action states within the finite state machine.
