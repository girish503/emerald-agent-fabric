# Emerald Agent Fabric: Workspace Sandbox & Filesystem Isolation Architecture

## Document Information
- **Status**: Architecture Specification — Phase 3 Baseline
- **Governing Constitution**: [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- **Layer**: Architecture Specification
- **Related ADR**: [ADR-0003: Workspace Sandbox Boundary and Typed Tool System Architecture](../adr/ADR-0003-workspace-and-typed-tools.md)
- **Upstream Dependencies**: [Runtime Architecture](./runtime.md), [Security Architecture](./security.md), [ADR-0002](../adr/ADR-0002-runtime-kernel-and-durable-state-machine.md)

---

## 1. Context & Background

Emerald Agent Fabric has established a deterministic, crash-recoverable execution runtime (Capability 1) with durable state persistence in SQLite WAL mode, worker leasing with lease-fenced crash recovery, execution provider abstraction, container isolation ([`DockerExecutionProvider`](../../src/adapters/execution/docker-execution-provider.ts)), capability-based policy gates ([`PolicyEvaluator`](../../src/domain/policy.ts)), deterministic evidence recording and verification ([`DeterministicVerifier`](../../src/domain/verification.ts)), and cryptographic mission governance ([`MissionContract`](../../src/domain/mission-contract.ts)).

However, execution is currently restricted to synthetic, ephemeral operations (`echo`, `sum`, `slow`, `fail`) running either purely in-memory or in containers with an ephemeral in-memory tmpfs (`--tmpfs /tmp:rw,noexec,nosuid,size=64m`) and zero host filesystem mounts.

To enable autonomous software engineering agents to operate on real software systems, the fabric requires a robust **Workspace Sandbox**. The workspace sandbox must provide an isolated, dedicated directory structure where real software repositories can be acquired at immutable revisions, inspected, modified, and built by typed tools without exposing the host filesystem, leaking credentials, or compromising reproducibility.

---

## 2. Problem Statement

Allowing an untrusted agent or language model to interact with a filesystem introduces severe systems engineering and security failure modes:
1. **Host Filesystem Contamination**: Naive file tools operating on host paths risk accidental or malicious directory traversal (`../../etc/passwd`), arbitrary file overwriting, or destruction of development machine files.
2. **Cross-Run State Leakage**: When multiple agent runs share mutable directories, residual artifacts (build caches, modified files, uncommitted git state) corrupt subsequent runs, destroying determinism and benchmark reproducibility.
3. **Symlink Escape Attacks**: Malicious repository contents or generated files can introduce symlinks pointing to sensitive host directories (e.g. `~/.ssh`, `~/.aws`, Docker daemon sockets). Subsequent tool reads or writes blindly follow the link out of the sandbox.
4. **Orphaned Storage & Disk Exhaustion**: A crashed worker process, aborted container, or runaway build process can leak gigabytes of temporary data, eventually starving the host machine of disk space or inodes.
5. **Non-Deterministic Repository State**: If an agent operates on a moving target (e.g. `git clone https://... master`), subsequent runs cannot be deterministically replayed or verified against the exact historical environment.

---

## 3. Goals & Non-Goals

### Goals
- **Isolated Workspace Lifecycle**: Provision, lease, maintain, and tear down strictly bounded local workspace directories per execution run.
- **Provider-Independent Repository Acquisition**: Support acquiring repositories from abstract sources (Git URL, local directory template, archive tarball) and checking out an exact, immutable revision (commit SHA).
- **Hard Filesystem Boundary**: Guarantee that no tool invocation can read, write, stat, or list paths outside the designated workspace root, even in the presence of `../`, absolute paths, or nested symlinks.
- **Container Volume Encapsulation**: Mount the isolated workspace into [`DockerExecutionProvider`](../../src/adapters/execution/docker-execution-provider.ts) at a fixed container mount path (`/workspace`) while keeping the container rootfs read-only (`--read-only`) and dropping all Linux capabilities.
- **Fail-Closed Teardown & Sweeper Cleanup**: Unconditionally destroy workspace storage upon run completion, failure, timeout, or cancellation. Sweeper recovers and cleans orphaned workspaces left by dead workers.
- **Resource & Quota Bounding**: Enforce maximum workspace disk bytes and file size limits governed by [`MissionContract`](../../src/domain/mission-contract.ts) authority (strictly rejecting requests exceeding contract ceilings) and bounded by provider/tool safety limits.

### Non-Goals
- **No Cloud / Distributed Storage**: Zero dependency on S3, NFS, Ceph, Kubernetes PersistentVolumes, or remote cloud daemons in Phase 3. Initial implementation is local CPU-first.
- **No Multi-Tenant MicroVMs**: Phase 3 targets local process/container isolation using Docker/OCI on standard workstations. Dedicated hardware microVM isolation (Firecracker, gVisor) is reserved for future multi-tenant cloud tiers.
- **No Automatic Credential Ingestion**: Workspaces must never contain raw user SSH keys, Git tokens, or host configuration files (`~/.gitconfig`, `~/.ssh/id_rsa`).
- **No Direct Agent Control Over Workspace Management**: The agent never provisions, configures, or mounts workspaces. The runtime orchestrator owns the workspace boundary.

---

## 4. Existing Constraints & Inherited Invariants

The Workspace Sandbox directly inherits and preserves all existing runtime invariants:
1. **Hexagonal Dependency Inversion**: Pure domain models (`Run`, `Policy`, `MissionContract`) depend only on ports. Filesystem I/O and Docker volume mounting belong strictly to adapters.
2. **Fail-Closed Security**: If workspace provisioning fails, path validation detects traversal, or Docker volume mounting fails, execution fails closed (`FAILED`). No fallback to un-isolated host execution is permitted.
3. **Mission Contract Authority & Resource Ceilings**: Requested resource limits above the authoritative `MissionContract.spec.resourceLimits` MUST be rejected (`ResourceLimitExceededError`), never silently clamped. An operational limit may narrow an already-authorized value, but no layer may silently convert an unauthorized request into an authorized narrower request.
4. **Deterministic Auditability**: Every significant workspace lifecycle event (`workspace.provisioned`, `workspace.disposed`, `workspace.cleanup_failed`) is emitted into the append-only `run_events` log.

---

## 5. Architectural Model & Component Boundaries

```text
                        ┌────────────────────────┐
                        │      WorkerRuntime     │
                        └───────────┬────────────┘
                                    │
               1. Request Workspace │ 5. Release / Teardown
                                    ▼
                        ┌────────────────────────┐
                        │   WorkspaceManager     │ (Application Service)
                        └─────┬────────────┬─────┘
                              │            │
         2. Acquire Repo Source│            │ 3. Allocate Isolated Dir
                              ▼            ▼
             ┌─────────────────────┐  ┌───────────────────────┐
             │RepositoryAcquisition│  │   Filesystem Sandbox  │
             │     Adapter         │  │   Path Sanitizer      │
             └─────────────────────┘  └───────────┬───────────┘
                                                  │
                                                  │ 4. Bind Mount Host Path
                                                  ▼
                                     ┌─────────────────────────┐
                                     │ DockerExecutionProvider │
                                     │  -v /host/path:/workspace│
                                     │  --read-only rootfs     │
                                     │  --user 1000:1000       │
                                     └─────────────────────────┘
```

### 5.1 Domain & Port Interfaces

#### 1. `WorkspaceSpec` (Domain Value Object)
```typescript
export interface WorkspaceSpec {
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly repositorySource?: RepositorySource;
  readonly maxWorkspaceBytes: number; // Provider safety limit (default 500 MB; cannot exceed contract authority if governed)
  readonly maxFileSizeBytes: number;    // Effective limit: rejected if exceeds contract maxOutputBytes; bounded by provider safety limit (e.g. 10 MB)
}

export interface RepositorySource {
  readonly type: "git" | "archive" | "local_template";
  readonly location: string;           // URL, path, or package identifier
  readonly revision: string;           // Exact immutable Git commit SHA or archive hash
}
```

#### 2. `WorkspaceHandle` (Application Value Object)
```typescript
export interface WorkspaceHandle {
  readonly workspaceId: string;
  readonly runId: string;
  readonly hostPath: string;           // Canonical absolute path on host
  readonly containerMountPath: string; // Fixed: "/workspace"
  readonly createdAt: string;
  readonly maxWorkspaceBytes: number;
}
```

#### 3. `WorkspaceManagerPort` (Port Interface)
```typescript
export interface WorkspaceManagerPort {
  provisionWorkspace(spec: WorkspaceSpec): Promise<WorkspaceHandle>;
  resolvePath(handle: WorkspaceHandle, relativePath: string): Promise<string>;
  disposeWorkspace(workspaceId: string): Promise<void>;
  cleanupOrphanedWorkspaces(activeWorkspaceIds: ReadonlySet<string>): Promise<readonly string[]>;
}
```

#### 4. `RepositoryAcquisitionPort` (Port Interface)
```typescript
export interface RepositoryAcquisitionPort {
  acquire(source: RepositorySource, targetDirectory: string): Promise<{
    readonly resolvedRevision: string;
    readonly fileCount: number;
    readonly totalBytes: number;
  }>;
}
```

---

## 6. Workspace Lifecycle & State Transitions

The workspace follows a strict, time-bounded lifecycle coupled to worker leasing:

```text
   [ UNALLOCATED ]
          │
          │ provisionWorkspace()
          ▼
   [ PROVISIONING ] ──(Acquisition Failure)──► [ FAILED ]
          │                                        │
          │ Dir Created & Repo Checked Out         │
          ▼                                        │
      [ READY ]                                    │
          │                                        │
          │ Worker Claims Lease                    │
          ▼                                        │
     [ LEASED ] ◄────────────────────┐             │
          │                          │             │
          │ Tool Invocations         │ Retries     │
          │ (Read/Write/Exec)        │             │
          ▼                          │             │
     [ CLEANING ] ───────────────────┘             │
          │                                        │
          │ disposeWorkspace()                     │
          ▼                                        ▼
    [ DISPOSED ]                             [ QUARANTINED ]
```

### Lifecycle States
1. **`PROVISIONING`**: Host directory created under `EMERALD_WORKSPACE_ROOT/<workspaceId>`. Strict POSIX permissions (0700) set. Repository acquisition initiated.
2. **`READY`**: Repository checked out at exact immutable revision. Workspace size verified against quota. Ready for container volume mount.
3. **`LEASED`**: Actively mounted into execution containers for tool steps. Owned exclusively by the active worker holding the run lease.
4. **`CLEANING`**: Execution has completed, failed, timed out, or cancelled. Worker or sweeper initiates recursive unmount and deletion.
5. **`DISPOSED`**: Host directory completely removed from filesystem. Disk space reclaimed.
6. **`FAILED` / `QUARANTINED`**: If cleanup encounters permission or I/O locks, workspace is quarantined and logged for administrative sweeper disposal.

---

## 7. Repository Acquisition & Immutable Revision Pinning

Emerald software engineering runs must be deterministic and reproducible. To satisfy this requirement:

### 7.1 Immutable Revision Guarantee
- Every repository acquisition source **MUST** specify an immutable revision (e.g. full 40-character Git commit SHA: `4b825dc642cb6eb9a060e54bf8d69288fbee4904`).
- Branch names (`main`, `master`, `HEAD`) or mutable tags (`v1.0`) are strictly forbidden as primary execution targets. If a task input specifies a branch or tag, it must be resolved to a commit SHA during task validation or contract creation before the workspace is provisioned.
- The `RepositoryAcquisitionPort` verifies post-checkout:
  `git rev-parse HEAD === expectedRevisionSHA`
  If the check fails, provisioning fails closed with `INVALID_REPOSITORY_REVISION`.

### 7.2 Abstract Provider Strategy
Initial local implementation provides:
1. **`LocalTemplateAcquisitionAdapter`**: Copies a designated local clean repository path into the workspace and resets to commit SHA (fastest for local tests and benchmarks).
2. **`GitCliAcquisitionAdapter`**: Performs shallow clone of specified commit SHA into target directory without credentials:
   `git init && git remote add origin <url> && git fetch --depth 1 origin <sha> && git checkout <sha>`
   *Rule*: Permanent git credentials (`.git/config` credentials or global credentials) are stripped immediately upon checkout.

---

## 8. Host, Workspace, and Container Boundaries

The host and container boundaries are strictly segregated to prevent container breakouts or host leakage:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ HOST SYSTEM (Untrusted Developer Machine)                              │
│                                                                        │
│  Base Dir: /var/run/emerald/workspaces (or %LOCALAPPDATA%\emerald)     │
│  Workspace Dir: .../workspaces/ws-019248-abcd (Mode 0700)              │
│                                                                        │
│      ┌──────────────────────────────────────────────────────────┐      │
│      │ DOCKER CONTAINER SANDBOX                                 │      │
│      │                                                          │      │
│      │  Root Filesystem: / (READ-ONLY)                          │      │
│      │  User: uid=1000, gid=1000 (Non-root)                    │      │
│      │  Caps: CapDrop=ALL, no-new-privileges                    │      │
│      │  Network: NONE (--network=none)                          │      │
│      │  Tmpfs: /tmp (size=64m, noexec, nosuid)                  │      │
│      │                                                          │      │
│      │  MOUNT: /workspace ◄───(Bind Mount rw)─── [Host Dir]     │      │
│      │                                                          │      │
│      │  FORBIDDEN MOUNTS:                                       │      │
│      │   - /var/run/docker.sock (NEVER MOUNTED)                 │      │
│      │   - / (Host root) (NEVER MOUNTED)                        │      │
│      │   - ~/.ssh, ~/.aws, ~/.config (NEVER MOUNTED)            │      │
│      └──────────────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────────────────┘
```

### 8.1 Mount Rules & Invariants
1. **Single Mount Point**: Exactly one volume bind mount is allowed: Host workspace path mapped to `/workspace`.
2. **Container Root Read-Only**: The container operating system filesystem is mounted read-only (`--read-only`). The container cannot modify binaries, packages, or system libraries.
3. **No Socket Mounting**: The Docker socket (`/var/run/docker.sock`) is **STRICTLY PROHIBITED** from entering the container under any circumstance.
4. **No Host Home Mounting**: Host user directories (`$HOME`, `~/.ssh`, `~/.aws`, `~/.bashrc`) are never mounted or exposed.
5. **Isolated Tmpfs**: `/tmp` is an in-memory tmpfs with flags `rw,noexec,nosuid,size=64m`. Code cannot execute out of `/tmp`.

---

## 9. Filesystem Traversal, Path Sanitization & Symlink Containment

The greatest risk in filesystem tool execution is **directory traversal** and **symlink escaping**. Emerald enforces multi-layered path containment in both the application layer and the OS container boundary.

### 9.1 Multi-Layered Path Sanitization Protocol

```text
Untrusted Input Path (e.g. "../../etc/passwd" or "symlink_to_root/secret")
                             │
                             ▼
              [ Layer 1: Lexical Normalization ]
                - path.normalize()
                - Reject NUL bytes (\0)
                - Strip leading slashes and anchor to workspace root
                             │
                             ▼
              [ Layer 2: Lexical Subpath Assertion ]
                - path.resolve(workspaceRoot, sanitizedRelPath)
                - Assert: resolvedPath.startsWith(workspaceRoot + path.sep)
                - IF FALSE: Throw PATH_TRAVERSAL_DETECTED (Fail Closed)
                             │
                             ▼
              [ Layer 3: Symlink Resolution & Canonicalization ]
                - fs.realpath() or step-by-step lstat loop
                - Resolve all intermediate path symlinks
                - Assert: canonicalRealPath.startsWith(workspaceCanonicalRoot)
                - IF FALSE: Throw SYMLINK_ESCAPES_WORKSPACE (Fail Closed)
                             │
                             ▼
              [ Layer 4: Container Namespace Boundary ]
                - Container chroot/mount namespace restricts process to /workspace
                - Linux kernel rejects traversal above container mount root
```

### 9.2 Path Sanitization Invariants
- **`NUL` Byte Rejection**: Paths containing `\0` are immediately rejected (`INVALID_PATH_CHARACTER`).
- **Forbidden Windows Characters**: If running on Windows hosts, colon (`:`), pipe (`|`), asterisks (`*`), question marks (`?`), and backslash normalization are strictly enforced.
- **Symlink Escape Prohibition**: Any file operation (`read_file`, `write_file`) that targets a symlink pointing outside the workspace root is rejected with `SYMLINK_ESCAPES_WORKSPACE`.
- **Dangling Symlink Policy**: Dangling symlinks cannot be traversed. Creating symlinks pointing to non-existent external paths is blocked.

---

## 10. Ownership, Permissions & Non-Root Execution

1. **Host Directory Permissions**: The workspace directory is created with `0700` (`rwx------`), accessible only by the Emerald host process UID.
2. **Container Process User**: Containers execute with an unprivileged non-root user (e.g. `UID 1000:GID 1000` or `node:node`).
3. **Privilege Escalation Block**: Containers run with `--security-opt=no-new-privileges` and `--cap-drop=ALL`. The agent cannot invoke `sudo`, `su`, or setuid binaries to escalate privileges.
4. **Shared Host UID Mapping**: On Linux hosts, the workspace directory ownership is aligned to UID 1000 so the container can write to `/workspace` without requiring root permissions.

---

## 11. Resource Limits & Authority Model

Workspace execution operates under strict governance boundaries, distinguishing between authoritative governance ceilings, requested operational values, and effective execution limits:

### 11.1 Resource Authorization Hierarchy

```text
MissionContract ceiling (Authoritative Governance Bound)
        ↓
requested operational value (Run creation / Tool action)
        ↓
        ├── requested > ceiling
        │       ↓
        │     REJECT (ResourceLimitExceededError — No Execution)
        │
        └── requested <= ceiling
                ↓
             ACCEPT
                ↓
        effective operational limit = min(requested, provider/tool safety limit)
```

We distinguish strictly between:
1. **Authorization Ceiling**: The maximum immutable value permitted by the governing `MissionContract.spec.resourceLimits`.
2. **Requested Operational Value**: The value explicitly requested by the caller, agent, or tool action.
3. **Effective Operational Limit**: A value that is equal to or narrower than the authorized ceiling, optionally tightened by provider/tool safety limits. The effective value must **NEVER** be used to hide an unauthorized broader request.

### 11.2 Required Architecture Rule

> **A lower operational limit MAY narrow authorized execution.**
>
> **A requested limit above MissionContract authority MUST be rejected.**
>
> **No layer may silently convert an unauthorized request into an authorized narrower request.**

Example:
```text
Contract timeout ceiling = 30s
Request = 20s                     → ACCEPT (within authority)
Request = 30s                     → ACCEPT (within authority)
Request = 40s                     → REJECT (ResourceLimitExceededError — zero execution)

If provider imposes an internal safety maximum = 10s:
Contract ceiling = 30s, Request = 20s, Provider max = 10s → Effective limit = 10s (Narrowing authorized request is permitted)
Contract ceiling = 30s, Request = 40s, Provider max = 10s → MUST NOT silently become 10s → MUST REJECT
```

### 11.3 Resource Terminology Mapping

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

Where a resource (such as workspace disk bytes, memory limit, or process count) is not currently part of the `MissionContract.spec.resourceLimits` schema, it is explicitly classified as a **provider/workspace safety limit** rather than contract authority.

---

## 12. Teardown, Cleanup & Crash Recovery

### 12.1 Unconditional Teardown
`WorkspaceManager.disposeWorkspace()` is invoked in a `finally` block on every execution termination path:
- Success (`COMPLETED`)
- Logical or physical failure (`FAILED`)
- Wall-clock timeout (`TIMED_OUT`)
- User or supervisor abort (`CANCELLED`)

### 12.2 Safe Deletion Procedure
Deleting arbitrary files generated by untrusted code can trigger deletion vulnerabilities (e.g. race conditions, symlinks traversed during recursive delete).
Emerald enforces a safe deletion strategy:
1. Ensure the container has been completely killed (`docker kill <container>` and `docker rm -f <container>`).
2. Verify host directory path: Confirm it matches `EMERALD_WORKSPACE_ROOT/<workspaceId>`.
3. Recursively adjust permissions (`chmod -R u+w`) to permit deletion of read-only files generated by builds.
4. Execute non-symlink-following recursive deletion (`fs.rm(path, { recursive: true, force: true })`).
5. Assert directory no longer exists on filesystem.

### 12.3 Sweeper Recovery of Orphaned Workspaces
If a worker crashes abruptly (SIGKILL, host reboot) before reaching the `finally` block:
- The `RunCoordinator.recoverExpiredLeases()` sweeper scans the `EMERALD_WORKSPACE_ROOT` directory.
- It compares existing disk directory names against active run leases in SQLite.
- Any directory older than `leaseTtlMs * 3` without an active lease is classified as an **orphaned workspace**.
- The sweeper disposes of the directory, logs `workspace.orphaned_reclaimed`, and frees disk capacity.

---

## 13. Interaction with Existing Execution & Governance Boundaries

```text
MissionContract (ACTIVE)
      │
      ├── 1. Authorize contract & verify ACTIVE lifecycle status
      │
      ├── 2. Verify requested operational values <= contract resourceLimits:
      │      - IF requested > ceiling: REJECT (ResourceLimitExceededError)
      │      - IF requested <= ceiling: ACCEPT
      │
      ├── 3. Provision workspace:
      │      workspace = workspaceManager.provisionWorkspace(spec)
      │
      ├── 4. Tool Action Execution Loop (while ACTIVE):
      │      - Pre-Action Check: verify contract still ACTIVE
      │      - IF REVOKED: ABORT -> finish in-flight / terminate -> NO NEXT ACTION -> Teardown
      │      - Execute action via ExecutionProvider inside container
      │
      ├── 5. Collect Observation & Record Evidence:
      │      evidence = createEvidence(providerResult)
      │
      ├── 6. Deterministic Verification:
      │      verifier.verify(evidence, contract.verificationSpecs)
      │
      └── 7. Finally:
             workspaceManager.disposeWorkspace(workspace.workspaceId)
```

### 13.1 Honest Revocation & Process Termination Semantics

The governance boundary guarantees the following lifecycle behavior upon contract revocation:

```text
MissionContract ACTIVE
        ↓
Action authorization
        ↓
Tool execution
```

If the contract becomes `REVOKED`:

```text
current action
     ↓
finish / terminate according to defined semantics
     ↓
NO NEXT ACTION
     ↓
workspace cleanup
```

**Exact Process Termination Guarantees**:
1. **Pre-Action Synchronous Boundary**: The runtime verifies `contract.lifecycle.status === "ACTIVE"` before authorizing each tool action. If revoked, dispatch is aborted immediately with `CONTRACT_REVOKED`, and **`NO NEXT ACTION`** is executed.
2. **In-Flight Action Termination**:
   - *Container Isolation (`DockerExecutionProvider`)*: When revocation occurs while a container is executing, the provider attempts physical termination via `docker kill <containerName>` and `docker rm -f <containerName>`. However, because external OS and daemon process termination is inherently asynchronous, instant sub-millisecond preemption cannot be guaranteed.
   - *In-Process Operations (Node.js runtime)*: Node.js executes on a single-threaded event loop. Pure synchronous CPU loops or blocking file system calls cannot be asynchronously interrupted from within the same thread. Execution terminates only when the in-flight synchronous call yields or completes.
3. **Guaranteed Post-Revocation Cleanup**: Once the in-flight attempt finishes or terminates, the runtime guarantees that no subsequent action is ever authorized (`NO NEXT ACTION`). The workspace sandbox is unconditionally destroyed via `disposeWorkspace()`, and the `Run` transitions to terminal `FAILED` with error code `CONTRACT_REVOKED`.

---

## 14. Explicit Invariants

1. **Path Containment Invariant**: Every resolved filesystem path must strictly satisfy `resolvedPath.startsWith(workspaceRoot + path.sep)`. Zero paths outside the workspace root are ever touched.
2. **Resource Authority Invariant**: A lower operational limit MAY narrow authorized execution. A requested limit above MissionContract authority MUST be rejected (`ResourceLimitExceededError`). No layer may silently convert an unauthorized request into an authorized narrower request.
3. **Zero Socket Invariant**: The host Docker socket (`/var/run/docker.sock`) is never mounted, exposed, or referenced inside any workspace or container.
4. **Immutable Revision Invariant**: Repository acquisition requires an immutable revision (commit SHA). Mutable branch refs fail closed.
5. **Single-Lease Ownership**: Exactly one active worker lease owns a workspace at any time. Workspaces are never shared across concurrent runs.
6. **Guaranteed Teardown Invariant**: Every allocated workspace is guaranteed to be deleted either by the executing worker or by the crash-recovery sweeper.
7. **No Silent Downgrade**: If container isolation is required for workspace operations, execution cannot downgrade to un-isolated host filesystem operations if Docker is unavailable.
8. **Revocation Fail-Closed Invariant**: Upon contract revocation, zero subsequent actions are authorized (`NO NEXT ACTION`), in-flight execution termination is attempted, and workspace storage is unconditionally destroyed.
