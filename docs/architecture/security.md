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

---

## 5. Policy & Capability Authorization Boundary (Task 1.6)

### 5.1 Authorization vs Execution Separation
```text
Request
   ↓
Policy Evaluator (Domain: Is capability granted? What isolation is required?)
   ↓
Isolation Verification (WorkerRuntime: Can configured provider satisfy isolation?)
   ↓
ExecutionProvider (Infrastructure Adapter: Mechanical execution)
   ↓
Isolation / Sandbox
   ↓
Result
```
- **PolicyEvaluator (Domain)** answers: *"Is this capability allowed under this policy, and what isolation level is required?"* Pure domain logic with ZERO provider or Docker dependencies.
- **WorkerRuntime (Application)** verifies: Can the configured execution provider satisfy the required isolation level? Fails closed immediately if unsatisfied.
- **ExecutionProvider (Infrastructure)** answers: *"How do I mechanically execute this?"*
- Execution providers are mechanical execution engines and do NOT evaluate security policies.
- Policy enforcement occurs strictly upstream in `WorkerRuntime` prior to calling any `ExecutionProvider`. Providers cannot be called to bypass policy.

### 5.2 Core Security Invariants
1. **Deny-by-Default**:
   - Any capability not explicitly present in `policy.allowedCapabilities` is immediately denied (`CAPABILITY_NOT_GRANTED`).
2. **Explicit Vocabulary & Unknown Capability Rejection**:
   - Capabilities represent explicitly named, immutable classes of action (`execution.echo`, `execution.sum`, `execution.slow`, `execution.fail`).
   - Dynamic capabilities, wildcard grants, and unrecognized operations are strictly rejected (`UNKNOWN_CAPABILITY`).
3. **No Self-Authorization**:
   - All execution requests, operation names, and input payload contents are treated as untrusted.
   - An agent or operation cannot grant itself capabilities, elevate its permissions, or alter frozen policy objects via payload injection or prototype pollution.
4. **Isolation is Distinct from Capability Authorization**:
   - Capability authorization grants *what* action can be executed.
   - Isolation requirements (`IN_PROCESS` vs `ISOLATED`) govern *where* the action may execute.
   - Docker isolation reduces blast radius but is **NOT** an authorization mechanism.
5. **In-Process Execution Restrictions**:
   - `IN_PROCESS` execution is permitted exclusively when the operation is classified as trusted deterministic execution and explicitly granted in `trustedInProcessOperations`.
6. **Fail-Closed Isolation (Zero Downgrade)**:
   - When policy mandates `ISOLATED` execution and the isolated environment is unavailable or an in-process provider is selected, the policy evaluator **fails closed (FAIL CLOSED)** with `ISOLATION_REQUIREMENT_NOT_MET`.
   - The runtime never silently downgrades an isolated workload to in-process execution.
7. **Observable & Auditable**:
   - Every authorization decision is immutably logged into the run event stream via `policy.evaluated`.
   - Denied executions are transitioned to terminal `FAILED` status with structured error code `POLICY_DENIED`, releasing leases and preventing unsafe retry loops.

---

## 6. Evidence & Verification Security Boundary (Task 1.7)

### 6.1 Execution Claim vs Verifiable Evidence
```text
ExecutionProvider Claim (SUCCESS)
               ≠
     Verified Outcome
```
- A compromised, faulty, or hallucinating execution mechanism or agent may self-report `status = SUCCESS` with corrupted or fabricated outputs.
- Emerald rejects self-reported claims as proof of success. Success requires corroboration via structured, canonicalized `Evidence` evaluated by a pure `DeterministicVerifier`.

### 6.2 V1 Boundary Qualification
- **V1 Qualification**: V1 does **NOT** provide out-of-band independent observation.
- Current evidence is derived from provider outputs (`source: "PROVIDER_REPORTED"`).
- Independent out-of-band observation (external filesystem audits, out-of-process probes) is deferred to future sandbox milestones.

### 6.3 Secret Redaction & Content Hashing Pipeline
Execution outputs must never be persisted blindly into immutable event logs.
```text
Raw Observation
       ↓
Deterministic Redaction (token, secret, password, credential, authorization)
       ↓
Canonical JSON Serialization (lexicographically sorted keys, original array order)
       ↓
SHA-256 Content Digest (lowercase hex)
       ↓
Durable Event Persistence (evidence.recorded)
```
- **Integrity Rule**: The persisted `contentHash` represents the *persisted redacted representation*, ensuring mathematical correspondence between the digest and stored data.
- **Size Boundary**: Embedded summaries are capped at 64 KB. Payloads exceeding this limit omit raw content and transition to `CONTENT_HASH` to prevent event log bloat.

### 6.4 Verifier Security & Execution Safety
- **Zero Dynamic Execution**: The verifier treats all evidence as untrusted passive data. It never executes shell commands, never calls `eval()`, never performs dynamic imports, and makes no network or database calls.
- **Fail-Closed on Verification Failure**:
  ```text
  ExecutionProvider: SUCCESS
             ↓
  Verification: FAILED
             ↓
  FAIL CLOSED (error: VERIFICATION_FAILED)
             ↓
  ZERO run.completed events
  ```
- **Deterministic Terminal Failure**: Verification failure on deterministic operations represents a semantic violation. It transitions immediately to terminal `FAILED` without retrying.

---

## 7. Evidence Bundle Provenance & Secret Redaction (Phase 33)

### 7.1 Deterministic Redaction Policy
Before an `EvidenceBundle` is serialized or hashed:
- All payloads are traversed recursively via `redactSensitiveData`.
- Keys matching sensitive patterns (`token`, `secret`, `password`, `credential`, `authorization`, `api_key`, `access_key`, `private_key`) have their primitive values replaced with `"[REDACTED]"`.
- Non-secret coordination coordinates (`credentialScopes`, `idempotencyToken`, LLM token counts) are explicitly preserved.
- **Integrity Rule**: Cryptographic hashes are computed strictly over the *redacted canonical representation*. The bundle never claims unredacted authenticity for scrubbed credentials.

### 7.2 Passive Offline Verification Boundary
- `EvidenceReplayVerifier` treats bundles as untrusted input.
- Zero network I/O, zero SQLite access, zero dynamic evaluation (`eval`), and zero filesystem writes occur during replay.
- Protects evaluating environments from remote code execution or sandbox escapes when inspecting bundles produced by untrusted or compromised agents.

---

## 8. Untrusted Evidence Ingestion Boundary Security & Anti-Poisoning (Phase 34)

### 8.1 Threat Model for Remote Evidence
Cross-host evidence ingestion treats all incoming bundles as untrusted adversary-controlled input:
1. **Parser Exploits & DoS**: Attackers may submit multi-gigabyte files or JSON bombs. Defense: Immediate pre-parse payload gating at 10 MB (`BUNDLE_TOO_LARGE`).
2. **Path Traversal & Filename Injection**: Attackers may submit malicious `bundleId` strings (e.g. `../../etc/passwd` or `..\..\Windows`). Defense: Strict regex enforcement (`^[0-9a-f]{64}$`) on all archive filenames.
3. **Secret Exfiltration & Ingestion Poisoning**: Bundles containing leaked raw credentials must not be stored in archives. Defense: `containsUnredactedSecrets` scans recursive bundle payloads and quarantines violations with `SECURITY_POLICY_FAILURE`.
4. **Archive Poisoning / Identity Collisions**: Attackers may attempt to overwrite legitimate evidence using duplicate IDs. Defense: Strict content-addressed immutability. If bytes differ, `IDENTITY_CONFLICT` is returned, and existing files are protected from mutation.
5. **Remote Code Execution**: Verification must never evaluate code snippets, run terminal commands, or invoke models. Defense: Complete passive structural and cryptographic analysis.

---

## 9. Asymmetric Cryptographic Signing (Ed25519) & Key Authority Boundary (Phase 35)

### 9.1 Cryptographic Identity vs Content Integrity
Phase 35 separates content integrity from producer authenticity:
- **Content Integrity (SHA-256)**: Proves the bundle content has not suffered bit-rot or mutation.
- **Authenticity (Ed25519)**: Proves possession of the private key corresponding to the public key registered in the local authority.
- **Authority (Local Trusted Keyring)**: Evaluates whether the identified key is authorized (`TRUSTED`) or revoked (`REVOKED`).

### 9.2 Key Confidentiality & Anti-Leakage
- Private signing keys must never be serialized into `EvidenceBundle` JSON documents, written to the filesystem archive, committed to version control, or written to logs.
- Key fingerprints are computed as the SHA-256 digest of standard SPKI DER bytes, preventing key label spoofing.
- Verification occurs completely offline in memory with zero external network access, preventing key exfiltration or timing oracle attacks.
