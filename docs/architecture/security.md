# Emerald Agent Fabric: Security Architecture

## 1. Threat Model & Untrusted Boundaries
The architecture treats the following boundaries as untrusted:
1. **Task Input & Operation Parameters**: Can contain malformed data, schema-breaking keys, or attempted prototype pollution.
2. **Worker Identifiers**: Must be validated against the worker registry; rogue or stale workers must not forge lease renewals.
3. **Future Model & Tool Outputs**: Treated as untrusted payload strings subject to strict schema validation.
4. **Execution Runtime**: Host OS privileges must be isolated; Capability 1 uses pure in-process function execution, with OS isolation deferred to Phase 3.

---

## 2. Layered Trust Boundaries (Capability 1)

```
[ Untrusted Client / External Inputs ]
                  │
                  ▼
         [ Input Validation Gate ]
     Strict Zod Schemas / Property Stripping
                  │
                  ▼
         [ Domain State Machine ]
     Pure Invariant Checks / State Transition Validation
                  │
                  ▼
         [ Persistence Boundary ]
     100% Parameterized SQL Statements (SQLite Prepared)
                  │
                  ▼
         [ Worker / Lease Gate ]
     Fencing Token Verification (`lease_id`, `version`)
                  │
                  ▼
         [ Execution Boundary ]
     Isolated `OperationPort` (Pure Functions in Capability 1)
```

---

## 3. Core Security Controls

### 3.1 Input Validation & Schema Sanitization
- All task inputs and operation parameters are passed through strict Zod schemas with unknown key stripping (`z.object(...).strict()`).
- Prevents object prototype pollution and schema drift before data touches the database.

### 3.2 SQL Injection Defense
- 100% of SQLite database queries use prepared parameterized statements (`better-sqlite3` or typed SQLite bindings).
- Dynamic SQL string concatenation is strictly forbidden by repository lint rules.

### 3.3 Lease Fencing & Worker Isolation
- Workers cannot mutate a run unless they present the active, unexpired `lease_id` and matching `version`.
- Stale workers that stall past their lease expiration are fenced off; updates fail with 0 rows affected.

### 3.4 Event Log Integrity (Application-Level Append-Only)
- We explicitly do NOT claim that SQLite files are "cryptographically tamper-proof." An operator or attacker with raw OS filesystem write access could alter SQLite bytes directly.
- Instead, the architecture guarantees **application-level append-only immutability**:
  - The persistence repository exposes only an `appendEvent` method.
  - No `UPDATE` or `DELETE` SQL queries exist for `run_events` in the codebase.
  - Foreign key constraints and unique sequence constraints prevent sequence forgery through application APIs.

### 3.5 Secret Redaction & Log Hygiene
- Permanent credentials are never stored in `tasks`, `runs`, or `run_events`.
- Payloads are checked against a recursive redaction filter (`apiKey`, `password`, `token`, `secret`) before any JSON string is written to diagnostic stdout/stderr streams.

### 3.6 Operation Dispatch vs Authorization Gate
- Resolving an operation by `operationName` within an `ExecutionProvider` is mechanical execution routing, **NOT** an authorization mechanism.
- Future tool execution and agent capabilities must pass through policy and capability authorization gates before being dispatched to any execution provider.
- Execution providers report mechanical outcomes only and do not evaluate security policy.

---

## 4. Isolated Container Execution Boundary (Task 1.5)

### 4.1 Defense-in-Depth Model & Threat Realism
Docker containers provide process-level encapsulation to significantly reduce the blast radius of filesystem mutation and untrusted execution relative to in-process execution, but **containers are NOT an absolute security boundary**. 
- The container shares the host OS kernel (via WSL2 on Windows).
- Kernel vulnerabilities, container escape vectors, and Docker daemon flaws remain active parts of the threat model.
- Container isolation represents one defense-in-depth ring alongside strict schema sanitization, lease fencing, and outer policy authorization.

### 4.2 Isolation Controls & Threat Mitigations
1. **Network Disconnection**:
   - Docker `--network=none` is configured.
   - Normal container network connectivity is therefore disabled.
   - Platform/daemon network stack assumptions remain part of the threat model. Container network disconnection is defense-in-depth, not an absolute security boundary.
2. **Filesystem Boundaries**:
   - The container is isolated from host filesystem mounts, uses a read-only container root filesystem (`--read-only`), and has only explicitly controlled temporary writable storage.
   - No host directories or Docker daemon sockets (such as `/var/run/docker.sock`) are ever mounted into the container.
   - Constrained in-memory temporary directory: `--tmpfs /tmp:rw,noexec,nosuid,size=64m`. Files written here cannot be executed (`noexec`) and cannot escalate privileges (`nosuid`).
   - This setup significantly reduces the blast radius of filesystem mutation and untrusted execution relative to in-process execution, but does not represent an absolute filesystem security boundary.
3. **Privilege & Capability Stripping**:
   - Linux capabilities are completely stripped: `--cap-drop=ALL`.
   - Privilege escalation is disabled: `--security-opt=no-new-privileges`.
4. **Strict Resource Constraints**:
   - Memory is capped: `--memory=256m`.
   - CPU quota is restricted: `--cpus=0.5`.
   - Maximum processes/threads are capped: `--pids-limit=64` (mitigating fork bomb attacks).
5. **Zero Shell Injection Surface**:
   - Operations are selected strictly from an allowlist (`echo`, `sum`, `slow`, `fail`, `output-flood`).
   - Arbitrary shell commands are rejected before launching the container.
   - Input payloads are passed strictly via piped standard input (`stdin`), preventing shell escaping or command interpolation attacks.
6. **Denial of Service (Output Flooding) Defense**:
   - Stdout and stderr stream byte counters abort and destroy the container if output exceeds `maxOutputBytes` (1MB).

### 4.3 Fail-Closed Policy for Untrusted Operations
For untrusted execution where container isolation is required:
```text
Isolation required
      ↓
Docker unavailable
      ↓
FAIL CLOSED
```
- If the Docker daemon is unreachable or container execution fails to initialize, the system must **fail closed (FAIL CLOSED)** and return a terminal or retryable provider error without executing untrusted code on the host.
- In-process execution must **NOT** be treated or described as an automatic fallback for untrusted operations.
- In-process execution remains available exclusively for explicitly trusted deterministic operations within the runtime.

