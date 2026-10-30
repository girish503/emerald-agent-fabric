# Phase 35B — Cryptographic Signing & Authority Invariants
## Formal Invariants for Ed25519 Evidence Signing and Public-Key Verification

---

### I1 — Asymmetric Cryptographic Authenticity
A signed evidence bundle proves that the entity in possession of the private key corresponding to the declared public key signed the exact cryptographic identity of the bundle.

---

### I2 — Transitive Content Protection
The signature payload is defined as:
```json
{
  "bundleId": "<bundleId>",
  "formatVersion": "emerald-evidence-bundle-v1",
  "provenanceRoot": "<provenanceRoot>",
  "schemaVersion": 1
}
```
Because `bundleId` is the SHA-256 digest over the canonical JSON of all bundle data, and `provenanceRoot` is the SHA-256 Merkle root over all execution subsystems, signing this tuple transitively and cryptographically protects the complete contents of the accepted evidence bundle against tampering.

---

### I3 — Deterministic Public Key Fingerprint
The public key fingerprint is defined as:
$$\text{publicKeyFingerprint} = \text{SHA-256}(\text{SPKI DER bytes of Ed25519 public key})$$
This 64-character lowercase hex digest provides an unambiguous, deterministic identifier for any Ed25519 public key.

---

### I4 — Non-Circular Bundle Identity
The `bundleId` calculation strips any existing `signature` property before canonical JSON serialization:
$$\text{bundleId} = \text{computeBundleId}(\text{bundle without bundleId and signature})$$
This guarantees that `bundleId` and `provenanceRoot` are identical before and after signing, avoiding circular hash dependencies.

---

### I5 — Offline Local Authority
The `TrustedKeyring` is strictly an offline, in-memory local registry. Key resolution, fingerprinting, and status validation occur without network requests, DNS queries, OCSP, CRLs, or external CA servers.

---

### I6 — Fail-Closed Unknown Keys
Any incoming signed bundle whose `keyId` cannot be resolved in the local `TrustedKeyring` must be rejected immediately with reason code `UNKNOWN_SIGNING_KEY`.

---

### I7 — Fail-Closed Revoked Keys
Any incoming bundle signed by a key whose status in the keyring is `REVOKED` must be rejected with reason code `REVOKED_SIGNING_KEY` during ingestion.

---

### I8 — Dual Obligation: Signature and Replay Conjunction
Acceptance requires both valid signature authenticity AND deterministic replay validity:
$$\text{Accepted} \iff \text{ValidSignature} \wedge \text{ValidReplay} \wedge \text{ValidPolicy}$$
A cryptographically valid signature over replay-invalid evidence must be quarantined with `REPLAY_VERIFICATION_FAILURE`. Conversely, a replay-valid bundle with an invalid or untrusted signature must be quarantined.

---

### I9 — Private Key Confidentiality
Private keys must never be serialized into an `EvidenceBundle`, persisted into an archive, committed to source control, or logged.

---

### I10 — Deterministic Signed Content Digest
The `signedContentDigest` field in `EvidenceSignature` is:
$$\text{signedContentDigest} = \text{SHA-256}(\text{canonicalJsonStringify}(\text{signingPayload}))$$
Given the same bundle identity, the signed content digest is byte-for-byte invariant across platforms.

---

### I11 — Non-Destructive Key Rotation
When a key is transitioned to `REVOKED`:
- Newly ingested bundles signed by the revoked key are quarantined.
- Previously accepted bundles signed by the key remain intact in the content-addressed archive.
- Re-verification of historical bundles reports `signatureValid: true` and `authorityStatus: "REVOKED"`.

---

### I12 — Explicit Legacy Compatibility
Unsigned legacy bundles (Phase 33/34) are evaluated according to an explicit policy:
- Under legacy-compatible mode (`allowUnsignedLegacy: true`), unsigned bundles meeting all integrity and replay criteria are classified as `ACCEPTED` with signature status `UNSIGNED_LEGACY` and authority `NOT_ESTABLISHED`.
- Under strict mode (`allowUnsignedLegacy: false`), unsigned bundles are quarantined with `UNSIGNED_BUNDLE_REJECTED`.
- Legacy bundles are never falsely upgraded to signed status.

---

### I13 — Zero Dynamic Execution
Signature verification executes zero shell commands, candidate patches, tool operations, model inferences, or network requests. All verification is passive in-memory cryptography.

---

### I14 — Strict Algorithm Binding
The signature algorithm must be explicitly `"Ed25519"`. Any attempt to specify unsupported algorithms (e.g. RSA, HMAC, SHA256-alone) or omit the algorithm field must fail closed with `INVALID_SIGNATURE_PAYLOAD`.

---

### I15 — Signature Tamper Resistance
Any mutation of the 64-byte Ed25519 signature (bit flip, byte truncation, substitution) must cause cryptographic verification to fail immediately with `INVALID_SIGNATURE`.
