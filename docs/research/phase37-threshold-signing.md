# Phase 37 — Production Multi-Authority Threshold Evidence Signing Research & Implementation Report

## 1. Implementation Summary
Phase 37 implements a production-grade 2-of-3 multi-authority threshold evidence signing mechanism for Emerald Agent Fabric. This implementation directly resolves the critical security gap proven in Phase 36 (Attack A1), wherein a compromised producer private key could forge replay-valid and policy-valid synthetic evidence that single-authority verification accepted.

Under Phase 37, evidence bundle acceptance strictly requires at least two distinct trusted authorities to sign the identical canonical evidence identity before ingestion across the trust boundary.

The implementation consists of:
- **Domain Extensions (`src/domain/evidence-bundle.ts`)**:
  - `AuthorityRole`: `"WORKER_PRODUCER" | "SUPERVISOR" | "INDEPENDENT_VERIFIER"`
  - `EvidenceSignature.authorityId`: Stable authority identifier cryptographically bound to each signature
  - `EvidenceBundle.signatures`: Immutable array of authority signatures alongside legacy `signature`
  - `ThresholdPolicy`: `{ threshold: number; totalAuthorities: number; }`
  - `ThresholdEvaluationResult` and `ThresholdStatus`: Explicit evaluation states avoiding ambiguous booleans
  - `IngestionReasonCode`: Extended with `INSUFFICIENT_AUTHORITIES`, `DUPLICATE_AUTHORITY`, `REVOKED_AUTHORITY`, `UNKNOWN_AUTHORITY`, `BUNDLE_ID_MISMATCH`, and `PROVENANCE_ROOT_MISMATCH`
  - `computeBundleId`: Updated to strip `signatures` alongside `bundleId` and `signature`
- **Signer & Verifier Layer (`src/application/evidence-signer.ts`)**:
  - `TrustedKeyRecord` & `TrustedKeyring`: Extended with `authorityId` and `role`
  - `EvidenceSigner.sign`: Extended to support `authorityId`
  - `EvidenceSigner.addSignature`: Accumulates signatures across authorities without mutating content hashes
  - `EvidenceSignatureVerifier.verifySingleSignature`: Verifies individual signatures independently
  - `EvidenceThresholdVerifier.verifyThreshold`: Evaluates 2-of-3 quorum, enforces authority distinctness, and tracks failure reasons
- **Gateway & Archive Boundary (`src/application/evidence-ingestion-gateway.ts` & `src/adapters/persistence/file-system-evidence-archive.ts`)**:
  - `EvidenceIngestionGateway`: Validates multi-signature collection structure, enforces threshold policy, composes replay/policy gates, and quarantines invalid submissions
  - `FileSystemEvidenceArchive`: Supports re-verification of multi-authority bundles for historical audits under key revocation

## 2. Authority Model
Emerald Agent Fabric establishes three explicit authority roles:
```text
WORKER_PRODUCER
SUPERVISOR
INDEPENDENT_VERIFIER
```

Each authority is identified by:
- `authorityId`: Stable authority identity (e.g. `"WORKER_PRODUCER"`)
- `keyId`: Unique key identifier (e.g. `"worker-key"`)
- `role`: Canonical authority role
- `publicKey`: Ed25519 public key (SPKI format)
- `publicKeyFingerprint`: Deterministic SHA-256 fingerprint of SPKI DER bytes
- `status`: `"TRUSTED"` or `"REVOKED"`

Authority identity is cryptographically bound to the signature through key registration in `TrustedKeyring`. Authority identity is never inferred from array index or key ordering.

## 3. 2-of-3 Threshold Semantics
The default production acceptance policy is:
```text
threshold = 2
totalAuthorities = 3
```

Any pair of two distinct trusted authorities satisfies the quorum:
- `Worker + Supervisor` -> ACCEPTED
- `Worker + IndependentVerifier` -> ACCEPTED
- `Supervisor + IndependentVerifier` -> ACCEPTED

Any single authority alone fails:
- `Worker only` -> QUARANTINED (`INSUFFICIENT_AUTHORITIES`)
- `Supervisor only` -> QUARANTINED (`INSUFFICIENT_AUTHORITIES`)
- `IndependentVerifier only` -> QUARANTINED (`INSUFFICIENT_AUTHORITIES`)

Duplicate signatures from the same authority fail:
- `Worker + Worker` -> QUARANTINED (`DUPLICATE_AUTHORITY`, `INSUFFICIENT_AUTHORITIES`)
- `Supervisor + Supervisor` -> QUARANTINED (`DUPLICATE_AUTHORITY`, `INSUFFICIENT_AUTHORITIES`)

## 4. Cryptographic Binding
All authorities sign the identical canonical signing payload:
```json
{
  "bundleId": "<64-hex SHA-256>",
  "formatVersion": "emerald-evidence-bundle-v1",
  "provenanceRoot": "<64-hex SHA-256>",
  "schemaVersion": 1
}
```

Because `computeBundleId` strips both `signature` and `signatures`, the bundle identity and signing payload remain strictly invariant regardless of how many authority signatures are attached or their insertion order.

This cryptographic binding ensures:
- Signatures cannot be transplanted across bundles (Cross-Bundle Reuse fails)
- Signature substitution between authorities fails Ed25519 verification
- Tampering with `provenanceRoot` or `bundleId` immediately invalidates all signatures

## 5. Producer-Compromise Defense
The decisive security improvement justified by Phase 36 is demonstrated in test 13:
```text
Compromised Worker possessing WORKER_PRODUCER private key
  ↓
Fabricates synthetic execution trajectory & fake tool outputs
  ↓
Generates valid bundleId & valid provenanceRoot
  ↓
Signs with genuine worker private key
  ↓
Produces replay-valid & policy-valid bundle
  ↓
Ingested into Phase 37 Gateway
  ↓
INSUFFICIENT_AUTHORITIES (QUARANTINED)
```
Because the attacker does not control the Supervisor or Independent Verifier private keys, the forged bundle cannot reach the 2-of-3 threshold and is permanently quarantined.

## 6. Replay + Policy Composition
Quorum authorization is never sufficient on its own. Evidence acceptance requires strict conjunctive satisfaction of four gates:
```text
ThresholdSatisfied (>= 2 distinct trusted authorities)
  AND ReplayValid (Fourfold outcome: taskSatisfied, verificationPassed, policySatisfied, evidenceComplete)
  AND PolicyValid (execution policy constraints satisfied)
  AND SecretPolicySatisfied (no unredacted credentials or tokens)
```

Tests 25-28 verify that even when a 2-of-3 quorum is present:
- Falsified attempt outcomes are quarantined (`REPLAY_VERIFICATION_FAILURE`)
- Leaked credentials or tokens are quarantined (`SECURITY_POLICY_FAILURE`)
- Prohibited capability invocations are quarantined (`SECURITY_POLICY_FAILURE`)

## 7. Key Rotation
Key lifecycle is managed through the `TrustedKeyring`:
- When an authority key is marked `REVOKED`, it is immediately rejected for new submissions (`REVOKED_AUTHORITY`, `INSUFFICIENT_AUTHORITIES`).
- Revoked keys cannot count toward threshold or substitute for trusted authorities.
- Historical audits use `allowRevokedForHistorical: true` to confirm cryptographic authenticity at time of signing without retroactively mutating the archive.

## 8. Historical Evidence
Backward compatibility is strictly preserved:
- Unsigned historical bundles continue to pass under `allowUnsignedLegacy: true` reporting `signatureStatus: "UNSIGNED_LEGACY"`.
- Under strict mode (`allowUnsignedLegacy: false`), unsigned bundles are rejected with `UNSIGNED_BUNDLE_REJECTED`.
- Legacy gateways without a threshold policy retain single-signature Phase 35 behavior.
- Archived bundles are immutably preserved; re-verification against the current keyring reports current key revocation status without modifying the file.

## 9. Archive Semantics
Bundles enter `archive/accepted/` only after passing all four gates.
Idempotent submissions return `status: "DUPLICATE"` with the existing archive path.
Payloads matching an existing `bundleId` but differing in canonical content are rejected with `IDENTITY_CONFLICT` and quarantined without overwriting the archive.

## 10. Attack Results
| Attack Vector | Simulated Condition | Result | Defense Mechanism |
|---|---|---|---|
| A1: Producer Compromise | Attacker signs synthetic bundle with worker key | QUARANTINED | 2-of-3 threshold requires 2nd authority |
| A2: Duplicate Replay | Same worker key signs twice | QUARANTINED | Deduplication by `authorityId` |
| A3: Signature Substitution | Worker signature placed under Supervisor keyId | QUARANTINED | Ed25519 signature verification failure |
| A4: Cross-Bundle Transplant | Valid signatures moved to differing bundleId | QUARANTINED | Signed content digest mismatch |
| A5: Revoked Authority | Submission using revoked supervisor key | QUARANTINED | Keyring status check rejects revoked keys |
| A6: Quorum + Replay Tampering | 2 valid signatures on falsified run status | QUARANTINED | Fourfold replay verifier catches false status |
| A7: Quorum + Secret Leakage | 2 valid signatures on unredacted token | QUARANTINED | Secret scanner flags sensitive pattern |

## 11. Security Guarantees
1. **Single-Authority Resilience**: No single compromised authority can forge accepted evidence.
2. **Liveness Tolerance**: System continues to accept valid evidence if any one authority is offline or corrupt.
3. **Identity Binding**: Signatures are cryptographically linked to canonical content and authority identity.
4. **Deterministic Evaluation**: Quorum evaluation is pure, repeatable, and independent of signature/authority order.

## 12. Explicit Non-Guarantees
1. **Keyring Compromise**: Quorum provides zero defense if an attacker modifies the local trusted keyring registry.
2. **Multi-Authority Collusion**: If 2 out of 3 authorities are compromised, invalid bundles will pass threshold authorization.
3. **Physical / Organizational Separation**: In this phase, all three keypairs execute within local test fixtures; real operational independence requires separate host boundaries.
4. **Distributed Consensus**: This is an evidence authorization filter, not a distributed consensus protocol or blockchain.

## 13. Test Results
All 38 integration tests pass deterministically in `tests/integration/phase37-threshold-signing.test.ts`.

## 14. Regression Results
- `tests/integration/phase37-threshold-signing.test.ts`: 38 / 38 passed
- `tests/integration/phase36-multi-authority-security.test.ts`: 15 / 15 passed
- `tests/integration/phase35-signature-authority.test.ts`: 30 / 30 passed
- `tests/integration/phase34-evidence-ingestion.test.ts`: 25 / 25 passed
- `tests/integration/phase33-evidence-replay.test.ts`: 23 / 23 passed
- `tests/persistence/phase32-contract-checkpoint-supervisor.test.ts`: 24 / 24 passed
- `tests/persistence/phase31-recovery-fencing.test.ts`: 18 / 18 passed
- `tests/integration/phase14-independent-verification.test.ts`: 11 / 11 passed
- TypeScript typecheck (`tsc --noEmit`): 0 errors

## 15. Performance / Coordination Cost
- Ed25519 signature generation latency: ~0.15ms per authority on standard CPU.
- Quorum verification latency: ~0.35ms for 3 signatures.
- Total ingestion overhead added: < 1ms per bundle.
- Memory overhead: Negligible (~200 bytes per signature in JSON bundle).

## 16. Remaining Risks
- The Independent Verifier role is currently simulated in local test fixtures; runtime operational separation across independent execution processes remains a future deployment task.
- Keyring distribution and out-of-band revocation updates remain outside the gateway scope.

## 17. Next Phase Recommendation
With the 2-of-3 threshold authority mechanism cleanly established and verified, proceed to operationalize authority separation or evaluate independent verification pipelines without expanding distributed complexity.
