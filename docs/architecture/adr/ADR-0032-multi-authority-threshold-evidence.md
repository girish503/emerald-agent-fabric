# ADR-0032: Multi-Authority Threshold Evidence Signing (2-of-3)

## Status
Accepted (Phase 37)

## Context
Phase 36 demonstrated a concrete security vulnerability against single-authority evidence signing (A1 Attack Demonstration):
> A compromised producer private key can create a cryptographically valid, replay-valid, policy-valid synthetic execution bundle that Phase 35 single-authority verification accepts.

Single-key authority establishes that *an authorized entity possessing that key signed the payload*, but cannot distinguish authentic execution from a malicious or compromised worker forging state and telemetry offline.

Phase 36 evaluated multi-authority models and demonstrated:
1. Independent supervisor endorsement rejects worker-only forgeries.
2. Duplicate authority identities must not count multiple times toward a quorum.
3. Strict M-of-M (e.g. 2-of-2) creates severe liveness/availability failures when one honest authority experiences a timeout or disagreement.
4. 2-of-3 provides a robust safety/availability tradeoff, permitting acceptance when any two distinct trusted authorities endorse the canonical bundle.
5. Quorum signing does not protect against trust-root (keyring) compromise.
6. Deterministic replay remains responsible for evidence consistency, while asymmetric signatures remain responsible for authority authenticity.

## Decision
Emerald Agent Fabric adopts a **2-of-3 threshold authority model** for production evidence acceptance.

### 1. Authority Identities and Roles
Three distinct authority identities are established:
- `WORKER_PRODUCER`: The worker executing the mission steps and generating primary evidence.
- `SUPERVISOR`: The supervisor tracking liveness, lease boundaries, and task completion.
- `INDEPENDENT_VERIFIER`: An independent evidence verification authority.

Each authority possesses a dedicated Ed25519 keypair registered in a local `TrustedKeyring` with fields:
`{ keyId, authorityId, role, publicKey, publicKeyFingerprint, status }` where status is `TRUSTED` or `REVOKED`.

### 2. Threshold Policy
The default production acceptance policy requires:
- `threshold = 2`
- `totalAuthorities = 3`

Acceptance strictly requires at least 2 distinct trusted authorities signing the identical canonical evidence identity.

### 3. Canonical Signed Identity
All authorities sign the identical canonical signing payload:
`{ bundleId, formatVersion: "emerald-evidence-bundle-v1", provenanceRoot, schemaVersion: 1 }`
Signatures are bound to this payload, preventing signature substitution, bundle substitution, and version confusion.

### 4. Authority Distinctness & Deduplication
Duplicate signatures from the same `authorityId` are deduplicated and counted exactly once. Duplicate authority submissions cannot satisfy the threshold and fail with `DUPLICATE_AUTHORITY` / `INSUFFICIENT_AUTHORITIES`.

### 5. Verification Gate Composition
Strict acceptance requires:
`ThresholdSatisfied AND ValidReplay AND ValidPolicy AND SecretPolicySatisfied`
No single gate implies acceptance in isolation.

### 6. Backward Compatibility
Legacy historical bundles without signatures remain supported when `allowUnsignedLegacy: true`. Gateways without an explicit threshold policy maintain single-signature Phase 35 behavior for historical replay, while production pipelines enforce 2-of-3 threshold authorization.

## Consequences

### Positive
- **A1 Vulnerability Eliminated**: A compromised worker possessing only its private key receives `INSUFFICIENT_AUTHORITIES` and is quarantined.
- **Tolerates Single-Authority Failure**: If one authority is offline or malicious, the remaining two honest authorities satisfy the 2-of-3 quorum.
- **Fail-Closed Enforcement**: Unknown keys, revoked keys, malformed signatures, and duplicate authorities reject immediately.
- **Auditable Historical Evidence**: Key revocation preserves historical verification auditability without retroactively mutating archived bundles.
- **₹0 and Local**: Built entirely on Node.js built-in `crypto` with zero external dependencies, cloud services, or network coordination.

### Negative / Tradeoffs
- Multi-signature payload size increases slightly (~200 bytes per additional signature).
- Verification computation requires 2-3 Ed25519 signature checks instead of 1.

## Security Guarantees
- No single compromised authority (Worker, Supervisor, or Verifier) can satisfy strict 2-of-3 evidence authorization alone.
- Replay verification prevents valid multi-signature bundles with falsified internal execution outcomes from being accepted.
- Canonical signing payload binds authority signatures immutably to bundle content and provenance root.

## Explicit Non-Guarantees
- **Keyring Compromise**: Quorum does not protect against an attacker with root write access to the trusted keyring registry.
- **Authority Collusion**: If 2 out of 3 authorities are compromised or collude, synthetic bundles will pass threshold authorization.
- **False-but-Honestly-Endorsed Evidence**: If authorities honestly witness corrupt external data, threshold signing confirms endorsement, not objective ground truth.
- **Distributed Consensus / Blockchain**: This is not a distributed Byzantine consensus protocol or distributed ledger; it is an evidence authorization layer.
- **Organizational Identity**: In local test fixtures, all authorities run locally; physical and administrative separation is an operational deployment property.

## Alternatives Rejected
- **2-of-2 Strict Quorum**: Rejected due to liveness failures under single-authority crash or transient network/timeout failure.
- **1-of-3 Disjunctive Model**: Rejected because it provides no security improvement over single-authority signing.
- **Single-Authority Signing**: Rejected because Phase 36 proved single producer compromise leads to undetected accepted forgeries.
- **Generalized Byzantine Consensus / Blockchain**: Rejected as speculative architecture violating simplicity, ₹0 cost, and local execution principles.
- **External Network PKI / CA**: Rejected to avoid external network dependencies and proprietary services.
