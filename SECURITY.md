# Security Policy — Emerald Agent Fabric

## Overview & Threat Model
Emerald Agent Fabric executes untrusted, autonomous AI agents against local or containerized execution environments. The runtime assumes by default that:
1. Model generation can be erratic, malicious, or susceptible to indirect prompt injection from repository contents or tool outputs.
2. Tool execution can fail, time out, or leak untrusted data.
3. Network endpoints and external services may be adversarial or unreliable.

Security does not rely on model system prompts. Protection is enforced structurally at every architectural boundary:
$$\text{Model} \longrightarrow \text{Tool Gateway} \longrightarrow \text{Policy Evaluator} \longrightarrow \text{Capability Guard} \longrightarrow \text{Sandbox Isolation}$$

---

## Core Security Invariants

### 1. Fail-Closed Verification Gates
- **Authoritative Runtime Gate**: Agents cannot unilaterally declare a task completed. Terminal success is determined exclusively by sovereign, deterministic verification specifications (e.g. clean-room test execution, command exit codes, cryptographic hash checks).
- **Unverified Completion Rejection**: If an agent claims completion without satisfying the contractual verification criteria, the claim is rejected (`UNVERIFIED_COMPLETION_CLAIM`).
- **Zero Self-Approval**: Sensitive or disruptive actions (e.g., privilege escalation, external network calls, critical resource modifications) require out-of-band durable approval. Self-approval by the agent is cryptographically and logically prohibited.

### 2. No Automatic Retries of Non-Idempotent Operations
- **Strict Mutation Fencing**: Destructive or non-idempotent filesystem and process operations are never blindly retried upon crash or disconnect.
- **Rollback Engine**: Incomplete or unverified mutation intents left by crashed workers are locked and rolled back by dedicated supervisor authorities before retrying tasks.
- **Lease Fencing**: Workers operate under strictly time-bounded leases. Once a lease expires, all pending mutations and execution results are rejected fail-closed to prevent split-brain execution.

### 3. Capability-Based Isolation & Sandbox Boundaries
- **Narrow Tool Scopes**: Tools are typed, bounded by execution timeouts, and restricted to allowed path patterns within the provisioned workspace.
- **Path Traversal Protection**: All filesystem accesses are validated against workspace containment roots. Traversal attacks (`..`, symlinks outside workspace) are immediately denied.
- **Non-Root & Dropped Privileges**: Container sandboxes drop unnecessary Linux capabilities (`CAP_NET_RAW`, etc.) and run with `no-new-privileges: true`.

### 4. Secret & Credential Protection
- Permanent operator credentials and private keys are never mounted or injected into agent execution sandboxes.
- Ephemeral credentials are bound to explicit mission contract scopes and revoked upon run termination.
- Sensitive environment variables (`.env`, auth tokens) are filtered and prevented from being logged to execution transcripts or persisted event streams.

---

## Reporting a Vulnerability

If you discover a security vulnerability within Emerald Agent Fabric:
1. **Do not** disclose the vulnerability publicly or open a public GitHub issue.
2. Report the vulnerability via private security advisory or email the maintainers directly.
3. Include detailed steps to reproduce, affected versions, and any relevant proof-of-concept manifests.
4. Maintainers will acknowledge receipt within 48 hours and coordinate remediation before public disclosure.
