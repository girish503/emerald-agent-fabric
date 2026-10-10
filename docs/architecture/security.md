# Emerald Agent Fabric: Security Architecture

## 1. Threat Model & Untrusted Boundaries
1. **Model Output**: Assumed untrusted. Can generate malicious commands, path traversals, or exploit attempts.
2. **Repository Files**: Assumed potentially hostile. Can contain indirect prompt injections, adversarial config files, or malicious build scripts.
3. **External Network**: Restrictive egress only. Default deny.
4. **Agent Sandbox**: Assume potential container escape attempts; harden with layered OS controls.

## 2. Defense-in-Depth Pipeline
```
Model Output
     │
     ▼
Typed Schema Validation (Zod)
     │
     ▼
Reflex Risk Check (Anomaly & Risk Scoring)
     │
     ▼
Security Policy Gate (Command blacklists, Path traversal checks)
     │
     ▼
Capability Grant (Token-bounded ephemeral permissions)
     │
     ▼
Sandbox Execution (OCI container, non-root, read-only rootfs, dropped caps, seccomp)
     │
     ▼
Network Firewall (Strict outbound rules, no secret access)
     │
     ▼
Human Approval Gate (Triggered if policy detects high-risk action)
```

## 3. Secret and Credential Handling
- Zero permanent credentials inside the sandbox.
- Ephemeral tokens with scoped access where necessary.
- Secret redaction filter applied to all stdout/stderr streams before events are persisted.
- Audit logs are immutable and tamper-evident.
