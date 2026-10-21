# Emerald Agent Fabric — Production Security Model

**Classification**: High-Assurance Agent Infrastructure  
**Status**: Production V1  
**Security Mandate**: Assume model output is untrusted and potentially adversarial. Never grant unmediated authority to models.

---

## 1. Trust Hierarchy & Separation of Powers

Emerald establishes three distinct security domains:

| Domain | Components | Trust Level | Authorities & Capabilities |
| :--- | :--- | :--- | :--- |
| **Untrusted** | Model Adapter, Prompt Generator, LLM Inference Output | **Zero Trust** | Can only propose JSON-formatted actions. Zero execution authority. Zero file system access. Zero network access. |
| **Governed** | Control Plane, Production Runtime Engine, Tool Gateway | **Constrained Trust** | Enforces typed validation, capability boundaries, rate limits, and path containment. May execute tools only when explicit authorization is granted by capability fences. |
| **Sovereign** | Clean-Room Verifier, Cryptographic Signer, Invariant Auditor | **Authoritative Trust** | Runs independently of the agent loop. Decides run completion, acceptance, proof hashing, and evidence sealing. Cannot be influenced by model declarations. |

---

## 2. Defense-in-Depth Pipeline

Every proposed action must navigate a multi-layered security lattice before reaching execution:

```
[Untrusted Model Proposal]
       │
       ▼
[Layer 1: Typed Schema Validation]
       │ Fail-closed on malformed JSON or unmapped fields
       ▼
[Layer 2: Capability Lattice Enforcer (C1–C20, N691–N720)]
       │ Rejects undeclared tools, expired leases, forbidden capabilities
       ▼
[Layer 3: Path Containment & Anti-Traversal Engine]
       │ Blocks `..`, symlink escapes, UNC paths, and forbidden directories (.git)
       ▼
[Layer 4: Cross-Harness Gateway (N696)]
       │ Sanitizes payloads crossing harness boundaries; strips unredacted secrets
       ▼
[Layer 5: Operator Approval Gate]
       │ Halts high-risk operations (deployments, destructive wipes) for human consent
       ▼
[Layer 6: Sandboxed Execution Environment]
       │ Local subprocess bounded by CPU time, output bytes, and unprivileged user
       ▼
[Layer 7: Sovereign Verification]
       │ Clean-room compilation, test suite execution, and cryptographic proof sealing
```

---

## 3. Capability Fencing & Invariant Lattice

The security model strictly enforces invariants `C1` through `C20` and controls `N691` through `N720`:

- **C1 & N691 (Forbidden Capabilities)**: Capabilities such as raw process execution, unauthorized network egress, and credential dumping are permanently forbidden and fail closed.
- **C5 & N694 (Anti-Laundering)**: Agents cannot launder prohibited actions by proxying them through sub-agents or intermediary harnesses.
- **C12 & N710 (Path Containment)**: All file system reads and writes must be fully resolved and contained within the assigned workspace path. Relative escapes (`../`) and absolute paths outside the workspace trigger immediate `PATH_TRAVERSAL` critical violations.
- **N711 (Tool Scope Bounding)**: Fences declare an immutable set of `allowedTools`. Invoking an undeclared tool triggers `SCOPE_BREACH` and is rejected fail-closed.
- **N700–N703 (Cryptographic Binding)**: Fences are cryptographically bound to the immutable `MissionContract` hash. Any hash or version mismatch results in lease revocation.

---

## 4. Secret Protection & Anti-Exfiltration

1. **Zero Permanent Credentials**: No production API keys, personal access tokens, or cloud credentials are permitted inside the workspace or execution environment.
2. **Automated Redaction**: Cross-harness gateway sanitizes outgoing and incoming payloads, stripping regex-matched tokens, keys, and environment variables.
3. **No Network Egress**: The default production configuration sets `networkAllowed: false`. Local inference (Ollama) communicates exclusively via localhost IPC/HTTP (`127.0.0.1:11434`), blocking unauthorized telemetry or external data exfiltration.

---

## 5. Sovereign Verification Guarantee

A run is NEVER completed simply because the model declares `"isGoalReached": true`.

Goal completion triggers clean-room sovereign verification:
1. Candidate changes are isolated.
2. Authoritative build toolchains execute independent of the agent.
3. Test suites execute to assert functional correctness.
4. An immutable proof hash is generated and embedded in the cryptographic evidence bundle.
5. If verification fails, the run status is marked `FAILED` or returned for governed recovery. Model claims are rejected without proof.
