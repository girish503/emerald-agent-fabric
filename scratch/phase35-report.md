# Phase 35 — Ed25519 Evidence Signing & Public-Key Authority Verification
## Comprehensive Research & Implementation Report

---

### 1. Baseline
- **Frozen Commit Baseline**: `70979cf4bcbf4a237b79af3a23449a4b932104d5`
- **Preceding Phase Context**:
  - Phase 33 implemented governed clean-room replay verification and evidence bundle export.
  - Phase 34 established an untrusted ingestion gateway and content-addressed immutable archive (`archive/accepted/<bundleId>.json`) with isolated quarantine.
  - Phase 34 established content integrity (SHA-256) and replay correctness, but left asymmetric cryptographic authenticity and producer identity as an explicit negative boundary.
- **Phase 35 Objective**: Implement asymmetric cryptographic signing using Ed25519 for `EvidenceBundle` artifacts and public-key authority verification against an offline local trusted keyring at the ingestion boundary.
- **Cost**: ₹0. Local-only execution, zero paid cloud or proprietary APIs, zero model downloads, zero Ollama inference.

---

### 2. Existing Cryptographic Semantics
Phase 35 builds upon the audited invariants from Phase 35A (`scratch/phase35-current-semantics.md`):
- **Content Integrity vs Authenticity**:
  - SHA-256 (`sha256Hex`) computes deterministic content hashes over canonical JSON structures, guaranteeing tamper evidence and bit-rot detection.
  - Ed25519 (`crypto.sign` / `crypto.verify`) proves possession of the private signing key and binds the execution evidence to an authorized producer authority.
- **Non-Circularity Invariant**:
  - `computeBundleId` excludes both `bundleId` and `signature` before computing the content hash.
  - As a result, signing an evidence bundle does not modify its `bundleId` or `provenanceRoot`.
- **Fail-Closed Pipeline**:
  - Signature verification happens prior to replay verification and acceptance. A failure in key lookup, algorithm conformance, fingerprint matching, or cryptographic verification immediately routes the payload to isolated quarantine.

---

### 3. Signing Payload
To prevent circular dependencies while guaranteeing transitive cryptographic coverage of the complete bundle, the signing payload is defined as:
```json
{
  "bundleId": "<bundleId>",
  "formatVersion": "emerald-evidence-bundle-v1",
  "provenanceRoot": "<provenanceRoot>",
  "schemaVersion": 1
}
```
- **Serialization**: The payload is serialized using RFC-8785 canonical JSON (`canonicalJsonStringify`), ensuring sorted keys, stable array ordering, and deterministic UTF-8 encoding.
- **Signed Content Digest**:
  $$\text{signedContentDigest} = \text{SHA-256}(\text{canonicalJsonStringify}(\text{signingPayload}))$$
- **Transitive Protection Proof**:
  - `bundleId` is a SHA-256 digest computed across every byte of `run`, `contract`, `checkpoints`, `events`, `actions`, `attempts`, `supervisorEvidence`, `verificationEvidence`, `verificationResults`, `terminalState`, and `provenance`.
  - `provenanceRoot` is a SHA-256 digest computed across the five subsystem roots (`contractHash`, `eventRoot`, `checkpointRoot`, `attemptRoot`, `verificationRoot`).
  - Because the ingestion gateway independently recomputes `bundleId` and `provenanceRoot` from raw data before verifying the signature, any modification to any field inside the bundle invalidates either the recomputation or the Ed25519 signature.

---

### 4. Ed25519 Implementation
Emerald uses the native Node.js standard library `node:crypto` implementation of RFC 8032 pure Ed25519:
- **Key Generation**: `crypto.generateKeyPairSync("ed25519")` producing native `KeyObject` instances.
- **Signing**: `crypto.sign(null, Buffer.from(canonicalString, "utf8"), privateKeyObj)` producing 64-byte raw signature buffers (128 hex characters).
- **Verification**: `crypto.verify(null, payloadBuffer, trustedRecord.publicKey, signatureBuffer)` operating entirely in memory.
- **Determinism**: Node.js RFC 8032 Ed25519 produces deterministic 64-byte signatures for identical payload and private key pairs.
- **Zero Third-Party Dependencies**: No external cryptographic npm packages or homemade mathematics were introduced.

---

### 5. Public-Key Fingerprinting
Key identities are cryptographically bound via a deterministic public-key fingerprint:
$$\text{publicKeyFingerprint} = \text{SHA-256}(\text{SPKI DER bytes of Ed25519 public key})$$
- **Standard SPKI DER**: Exporting the public key as SubjectPublicKeyInfo DER produces a standard 44-byte ASN.1 structure consisting of a 12-byte algorithm identifier (OID 1.3.101.112) followed by the 32-byte raw Ed25519 public key.
- **Unambiguous Hex Digest**: The fingerprint is formatted as a 64-character lowercase hexadecimal string (`^[0-9a-f]{64}$`).
- **Authority Decoupling**: Verification compares `signature.publicKeyFingerprint` directly against the fingerprint of the trusted public key registered in the keyring, preventing key label spoofing.

---

### 6. Trusted Keyring
The `TrustedKeyring` (`src/application/evidence-signer.ts`) provides a minimal, offline public-key registry:
- **Data Model**:
  ```typescript
  export interface TrustedKeyRecord {
    readonly keyId: string;
    readonly publicKey: crypto.KeyObject;
    readonly publicKeyPem: string;
    readonly publicKeyFingerprint: string;
    status: "TRUSTED" | "REVOKED";
  }
  ```
- **Operations**:
  - `registerKey({ keyId, publicKey, status })`: Parses SPKI PEM or `KeyObject`, asserts `asymmetricKeyType === "ed25519"`, computes fingerprint, and registers record.
  - `getKey(keyId)`: Resolves record by `keyId`.
  - `revokeKey(keyId)`: Transitions key status to `REVOKED`.
- **Offline Guarantee**: The keyring is purely local configuration. Zero DNS requests, zero OCSP queries, zero CRL downloads, and zero certificate authority hierarchies are employed.

---

### 7. Signature Verification
The `EvidenceSignatureVerifier` (`src/application/evidence-signer.ts`) performs pure in-memory verification:
1. **Structural Audit**: Validates `signature.algorithm === "Ed25519"`, `keyId` non-empty, and signature format (128 hex characters).
2. **Keyring Resolution**: Looks up `keyId` in `TrustedKeyring`. Fails with `UNKNOWN_SIGNING_KEY` if absent.
3. **Revocation Check**: Checks key status. Fails with `REVOKED_SIGNING_KEY` unless explicitly evaluating historical evidence under `allowRevokedForHistorical: true`.
4. **Fingerprint Verification**: Asserts `signature.publicKeyFingerprint === record.publicKeyFingerprint`. Discrepancies fail with `INVALID_PUBLIC_KEY`.
5. **Signed Content Digest Verification**: Recomputes `signedContentDigest` from the bundle identity tuple and compares against declared digest. Fails with `INVALID_SIGNATURE`.
6. **Cryptographic Verification**: Executes `crypto.verify` over the canonical UTF-8 payload bytes against the registered public key. Fails with `INVALID_SIGNATURE`.

---

### 8. Ingestion Integration
The `EvidenceIngestionGateway` integrates signature verification into its fail-closed pipeline:
```text
Raw Payload (String / Buffer)
  ↓ [1. Size Gating (< 10 MB)]
JSON Parser
  ↓ [2. Parse Validation]
Structural Schema Validator
  ↓ [3. Format & Schema Verification]
Signature Structure Validation
  ↓ [4. Algorithm === Ed25519, KeyId present, Hex lengths]
Bundle ID Recalculation
  ↓ [5. computeBundleId(content without bundleId/signature)]
Trusted-Key Lookup & Ed25519 Verification
  ↓ [6. Keyring check, Fingerprint check, crypto.verify]
Offline Clean-Room Replay Verification
  ↓ [7. EvidenceReplayVerifier.verify(bundle)]
Security Policy Scan
  ↓ [8. Secret redaction audit]
Archive Duplicate / Conflict Resolution
  ↓ [9. Idempotency vs Identity Conflict]
Content-Addressed Archival
  ↓ [10. Write to archive/accepted/<bundleId>.json]
Ingestion Result (ACCEPTED | DUPLICATE | QUARANTINED)
```
**Conjunctive Acceptance Rule**: Acceptance strictly requires:
$$\text{Accepted} \iff \text{ValidSignature} \wedge \text{ValidReplay} \wedge \text{ValidPolicy} \wedge \text{ValidIntegrity}$$
A valid signature over replay-invalid evidence is quarantined with `REPLAY_VERIFICATION_FAILURE`. A replay-valid bundle with an invalid signature is quarantined with `INVALID_SIGNATURE`.

---

### 9. Legacy Unsigned Bundles
Emerald provides an explicit, non-destructive policy for legacy Phase 33/34 bundles:
- **Default Legacy Mode (`allowUnsignedLegacy: true`)**: Unsigned bundles that satisfy all structural, cryptographic content hash, and replay criteria are classified as `ACCEPTED` with:
  - `signatureStatus = "UNSIGNED_LEGACY"`
  - `authorityStatus = "NOT_ESTABLISHED"`
- **Strict Authority Mode (`allowUnsignedLegacy: false`)**: Unsigned bundles are rejected immediately with `UNSIGNED_BUNDLE_REJECTED`.
- **Integrity Rule**: Unsigned legacy evidence is never falsely upgraded to signed status.

---

### 10. Key Rotation
Key rotation is implemented without rewriting historical evidence:
- Transitioning a key to `REVOKED` in the local keyring immediately halts acceptance of newly ingested bundles signed by that key (`REVOKED_SIGNING_KEY`).
- Previously accepted bundles signed by the revoked key remain intact in the content-addressed archive.
- Re-verification of historical bundles reports `signatureStatus = "VALID"` and `authorityStatus = "REVOKED"`.

---

### 11. Historical Evidence Handling
Historical Phase 10H, Phase 31, Phase 32, Phase 33, and Phase 34 artifacts remain byte-for-byte intact:
- Diagnostic scripts (`verify-phase10h-artifacts.ts`) verify that all 36 historical trial records remain intact.
- Phase 33 and Phase 34 integration test suites run against the updated gateway and pass 100% without modification.

---

### 12. Security Analysis
- **Private Key Confidentiality**: Private keys are never serialized into `EvidenceBundle` documents, written to the archive, logged, or committed to source control (verified by T20 and T21).
- **Public-Key Substitution Resistance**: If an attacker signs a bundle with their own key and claims an authorized `keyId`, fingerprint validation catches the substitution with `INVALID_PUBLIC_KEY`.
- **Algorithm Downgrade Prevention**: Only `"Ed25519"` is accepted. Attempts to specify `"RSA"`, HMAC, or none fail closed with `INVALID_SIGNATURE_PAYLOAD`.
- **Signature Bit-Flip Detection**: Any mutation or truncation of the 64-byte signature fails closed with `INVALID_SIGNATURE`.
- **Replay Protection**: A valid signature cannot bypass invalid execution evidence, broken event hash chains, or failed test runs.
- **Zero Network/Model Footprint**: Signing and verification execute zero network requests (verified by T29) and zero model inference calls (verified by T30).

---

### 13. Tamper Matrix
All 30 integration test scenarios in `tests/integration/phase35-signature-authority.test.ts` passed:

| Test ID | Scenario / Boundary | Expected Result | Actual Result |
| :--- | :--- | :--- | :--- |
| **T1** | Generate Ed25519 keypair | Ephemeral keypair with 64-hex fingerprint | **PASS** |
| **T2** | Sign valid bundle | Bundle signed with complete EvidenceSignature metadata | **PASS** |
| **T3** | Valid signature + trusted key | Ingestion classifies as `ACCEPTED` | **PASS** |
| **T4** | Modify bundle payload | Payload mutation invalidates signature $\to$ `QUARANTINED` | **PASS** |
| **T5** | Modify bundleId | Bundle ID mismatch $\to$ `QUARANTINED` (`INVALID_BUNDLE_ID`) | **PASS** |
| **T6** | Modify provenanceRoot | Provenance root mutation $\to$ `QUARANTINED` (`INVALID_SIGNATURE`) | **PASS** |
| **T7** | Modify signature bytes | Bit/byte mutation of signature $\to$ `QUARANTINED` (`INVALID_SIGNATURE`) | **PASS** |
| **T8** | Wrong public key | Fingerprint mismatch against keyring $\to$ `QUARANTINED` (`INVALID_PUBLIC_KEY`) | **PASS** |
| **T9** | Unknown keyId | KeyId not found in keyring $\to$ `QUARANTINED` (`UNKNOWN_SIGNING_KEY`) | **PASS** |
| **T10** | Revoked key | Submission from revoked key $\to$ `QUARANTINED` (`REVOKED_SIGNING_KEY`) | **PASS** |
| **T11** | Algorithm mismatch | Non-Ed25519 algorithm $\to$ `QUARANTINED` (`INVALID_SIGNATURE_PAYLOAD`) | **PASS** |
| **T12** | Truncated signature | Non-128-hex signature $\to$ `QUARANTINED` (`INVALID_SIGNATURE`) | **PASS** |
| **T13** | Malformed public key | Non-64-hex fingerprint $\to$ `QUARANTINED` (`INVALID_PUBLIC_KEY`) | **PASS** |
| **T14** | Valid signature + invalid replay | Semantic replay failure $\to$ `QUARANTINED` (`EVENT_INTEGRITY_FAILURE`) | **PASS** |
| **T15** | Replay-valid unsigned bundle | Accepted as `UNSIGNED_LEGACY` in default; rejected in strict mode | **PASS** |
| **T16** | Multi-key independence | Multiple trusted keys verify independent valid bundles | **PASS** |
| **T17** | Active key validation | Bundles signed by active keys pass verification | **PASS** |
| **T18** | Revoked key submission | Newly submitted bundles from revoked key rejected | **PASS** |
| **T19** | Historical re-verification | Historical bundle retained; re-verification reports authority `REVOKED` | **PASS** |
| **T20** | Private key leakage check | Private key string strictly absent from serialized bundle | **PASS** |
| **T21** | Private key archive check | Private key string strictly absent from filesystem archive | **PASS** |
| **T22** | Deterministic payload | Identical bundle yields identical canonical payload and digest | **PASS** |
| **T23** | Deterministic signature | Same bundle + same private key yields identical signature bytes | **PASS** |
| **T24** | Cross-host simulation | Export, sign, transfer raw string, wipe host A, ingest on host B | **PASS** |
| **T25** | Archive reload verification | Re-verification of archived signed bundle succeeds | **PASS** |
| **T26** | Archive file tampering | In-place disk tampering of signature detected during re-verification | **PASS** |
| **T27** | Historical unsigned bundle | Historical unsigned Phase 33 bundle re-verifies cleanly offline | **PASS** |
| **T28** | Duplicate semantics | Duplicate signed submission returns `DUPLICATE` without extra files | **PASS** |
| **T29** | Zero network access | Mocking network sockets confirms zero HTTP/HTTPS/net calls | **PASS** |
| **T30** | Zero model inference | Ingestion and verification perform zero model/Ollama invocations | **PASS** |

---

### 14. Cross-Host Simulation
Test T24 executes a simulated cross-host workflow:
1. **Producer Host A**: Executes a software-engineering task in its SQLite database, exports an `EvidenceBundle`, and signs it using its local Ed25519 private key.
2. **Serialization & Transfer**: Serializes the signed bundle to a raw JSON string. Host A's database and state are permanently deleted.
3. **Consumer Host B**: Configures an independent `FileSystemEvidenceArchive` and `EvidenceIngestionGateway` equipped only with Host A's public key in its local `TrustedKeyring`.
4. **Ingestion & Verification**: Host B ingests the untrusted raw JSON string, validates the format, verifies the Ed25519 signature, completes clean-room replay verification, and immutably archives the bundle with status `ACCEPTED`. Subsequent offline re-verification confirms complete integrity.

---

### 15. Test Results
- `tests/integration/phase35-signature-authority.test.ts`: **30 passed / 30 tests (100%)**
- Test execution duration: 1.88s (tests) / 3.96s total.

---

### 16. Regression Results
Full regression test sequence executed:
- `tests/integration/phase34-evidence-ingestion.test.ts`: **25/25 passed**
- `tests/integration/phase33-evidence-replay.test.ts`: **23/23 passed**
- `tests/persistence/phase32-contract-checkpoint-supervisor.test.ts`: **24/24 passed**
- `tests/persistence/phase31-recovery-fencing.test.ts`: **18/18 passed**
- `tests/integration/phase14-independent-verification.test.ts`: **11/11 passed**
- Complete integration test suite (`tests/integration/`): **161 passed | 1 skipped** (Ollama offline per zero-model constraint)
- Historical Phase 10H artifact integrity (`scripts/verify-phase10h-artifacts.ts`): **36/36 passed**
- TypeScript typecheck (`npx tsc --noEmit`): **CLEAN (0 errors)**
- Git diff check (`git diff --check`): **CLEAN (0 whitespace errors)**

---

### 17. Failure Classification
Zero failures observed during Phase 35 execution:
`failureClassification: []`

---

### 18. Remaining Risks & Negative Claims
1. **Identity Scope**: Ed25519 signatures prove possession of the private key corresponding to the public key in the local keyring. They do NOT establish human identity, organizational identity, legal non-repudiation, or certificate-backed identity.
2. **Key Custody**: Emerald assumes the producer host securely stores its private signing key. Hardware-backed signing (HSM / TPM / Secure Enclave) is not implemented.
3. **Local Trust Boundary**: The `TrustedKeyring` is an explicitly local configuration. Emerald does not implement distributed PKI, certificate authority hierarchies, or online revocation protocols.
4. **Physical Re-Execution**: As in Phase 33/34, verification validates structural, cryptographic, and replay consistency with recorded evidence; it does NOT physically re-execute external tool side effects.

---

### 19. Scientific / Architectural Conclusion
Emerald provides offline Ed25519 authenticity verification for evidence bundles against an explicitly configured local trusted-key authority, while retaining independent SHA-256 integrity verification and deterministic replay validation.

---

### 20. Phase 36 Recommendation
**Recommendation: Phase 36 — Multi-Authority Quorum Signing & Supervisor Endorsement.**
- **Next Step**: Extend single-producer signing to support threshold/quorum multi-signature endorsement (e.g. Worker Signature + Supervisor Endorsement Signature) before an evidence bundle can be certified for high-assurance autonomous deployment.
