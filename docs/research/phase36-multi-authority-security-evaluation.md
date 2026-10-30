# Phase 36 — Multi-Authority Quorum Security Evaluation

## 1. Research Question

Phase 35 introduced Ed25519 asymmetric cryptographic signing for Emerald `EvidenceBundle`s, establishing content authenticity and authorized producer identity against an offline `TrustedKeyring`. The research question for Phase 36 investigates whether extending this model to multi-authority quorum signing and supervisor endorsement provides a materially stronger integrity guarantee:

> **Central Research Question**:
> If evidence from an execution producer can be forged or compromised, can two or more independent authorities provide a materially stronger guarantee that the evidence represents a legitimate Emerald execution outcome?

To resolve this question empirically without introducing premature production abstractions, this research evaluates two competing architectures:

### Current Single-Authority Model (Phase 35)
$$\text{Producer} \longrightarrow \text{EvidenceBundle} \longrightarrow \text{Ed25519 Signature} \longrightarrow \text{TrustedKeyring} \longrightarrow \text{Replay} \longrightarrow \text{Policy} \longrightarrow \text{Archive}$$

### Hypothetical Multi-Authority Quorum Model
$$\text{Producer} \longrightarrow \text{EvidenceBundle} \longrightarrow \sum_{i=1}^M \text{Signature}_i \longrightarrow \text{Quorum Policy } (K \text{-of-} M) \longrightarrow \text{Replay} \longrightarrow \text{Policy} \longrightarrow \text{Archive}$$

This phase evaluates whether multi-authority quorum signing closes any concrete vulnerability demonstrated against Phase 35, or whether it merely introduces architectural complexity without improving security guarantees.

---

## 2. Threat Model

The evaluation defines an adversarial framework testing fifteen concrete attack scenarios ($A_1$ through $A_{15}$) against an offline, untrusted ingestion boundary:

1. **A1 — Compromised Producer Private Key**: The adversary obtains the producer's Ed25519 private key and fabricates a synthetic execution trajectory that never executed physically.
2. **A2 — Malicious but Validly Signed Bundle**: The adversary signs a bundle claiming task completion while recording failed exit codes.
3. **A3 — Valid Signature + False Operational Outcome**: The adversary signs a bundle with intact hash roots where the claimed operational outcome contradicts the fourfold derivation rules.
4. **A4 — Replay-Valid but Policy-Invalid Evidence**: The adversary submits internally consistent, signed evidence that violates repository credential policy by containing unredacted secrets.
5. **A5 — Revoked Producer Authority**: The adversary attempts to submit a bundle signed by a key that was subsequently revoked in the receiver's keyring.
6. **A6 — Supervisor Disagreement**: An independent supervisor refuses to sign (or issues an invalid signature) after observing an execution anomaly, while the worker claims success.
7. **A7 — Conflicting Valid Evidence for Same RunId**: The adversary submits two distinct validly signed bundles for the same logical `runId` under different content hashes.
8. **A8 — Signature Stripping**: The adversary strips the signature block from a signed bundle to evade identity attribution.
9. **A9 — Signature Substitution**: The adversary replaces genuine signature bytes with signatures from unknown, unrelated, or wrong keys.
10. **A10 — Keyring Compromise**: The adversary subverts the local `TrustedKeyring` trust root on the verifier node.
11. **A11 — One Malicious Authority in 2-of-3 Model**: One authority in a 3-member committee is compromised or faulty, while two authorities remain honest.
12. **A12 — Two Conflicting Honest Authorities**: Two honest evaluators reach divergent conclusions due to environmental non-determinism (e.g., timeout).
13. **A13 — Duplicate Authority Signatures**: The adversary replays multiple identical signatures from a single authority to reach a quorum threshold.
14. **A14 — Historical Revocation Audit**: Key revocation occurs after archival, testing whether historical evidence remains verifiable.
15. **A15 — Deterministic Attack Replay**: Repeated attack simulations are executed to verify that security decisions are 100% reproducible.

---

## 3. Existing Phase 35 Guarantee

Phase 35 provides a conjoined cryptographic and behavioral verification pipeline:

$$\text{Ingestion Status} = \text{ACCEPTED} \iff \text{ValidSignature} \wedge \text{ValidReplay} \wedge \text{ValidPolicy}$$

### Capabilities of Phase 35
1. **Asymmetric Authenticity**: Verifies that the payload was signed by an entity possessing the private key corresponding to a registered `keyId` in `TrustedKeyring`.
2. **Digest & Root Integrity**: Signs a canonical payload `canonicalJsonStringify({ bundleId, formatVersion, provenanceRoot, schemaVersion })`, binding the Ed25519 signature transitively to all subsystem Merkle roots.
3. **Fail-Closed Revocation**: Rejects new submissions signed by revoked keys with `REVOKED_SIGNING_KEY`.
4. **Historical Auditability**: Preserves offline verification of historical archived bundles signed before revocation (`status: VERIFIED`, `authorityStatus: REVOKED`).
5. **Conjunctive Policy Enforcement**: Quarantines bundles that violate data security policy (e.g., secret leakage) regardless of valid cryptographic signature.
6. **Deterministic Clean-Room Replay**: Evaluates execution events and attempt exit codes to derive the terminal outcome independently of producer claims.

### Demonstrated Limitations of Phase 35
1. **Unilateral Trust in Producer Key**: A single compromised producer private key allows the adversary to sign synthetic bundles that pass replay and policy checks if the synthetic trajectory is internally consistent.
2. **RunId Outcome Blindness**: Content-addressing (`bundleId = sha256(content)`) permits divergent bundles for the same `runId` to coexist in the archive without cross-bundle conflict detection.

---

## 4. Attack Results

All 15 attack scenarios were implemented and executed in `tests/integration/phase36-multi-authority-security.test.ts`.

### Attack A1: Compromised Producer Private Key
- **Setup**: Attacker possesses `producerKey.privateKey` and creates a synthetic bundle with fabricated tool outputs (`{ exitCode: 0, stdout: "Attacker fabricated tool output" }`). All Merkle roots (`attemptRoot`, `provenanceRoot`, `bundleId`) are recalculated consistently.
- **Phase 35 Ingestion**: **ACCEPTED** (`signatureStatus: VALID`, `authorityStatus: TRUSTED`). Single-authority ingestion cannot detect that the execution never occurred on physical hardware.
- **Hypothetical Quorum**: **REJECTED** (`MISSING_REQUIRED_AUTHORITY: supervisor-key`). The attacker lacks the supervisor's private key, preventing admission.
- **Classification**: **DEMONSTRATED**.

### Attack A2: Malicious but Validly Signed Bundle
- **Setup**: Attacker signs a bundle where `attempts[0].exitCode = 1` and `attempts[0].status = "FAILED"`, but sets `terminalState.status = "COMPLETED"`.
- **Phase 35 Ingestion**: **QUARANTINED** (`replayValid: false`, `reasonCodes: ["REPLAY_VERIFICATION_FAILURE"]`).
- **Conclusion**: Replay verification catches the false completion claim independently of the signature. Quorum signing is not required to catch this attack.
- **Classification**: **DEMONSTRATED**.

### Attack A3: Valid Signature + False Operational Outcome
- **Setup**: Attacker validly signs a bundle where the required verification command exited with code 1, but the producer asserts `status: "COMPLETED"`. Merkle roots are recomputed so signature and hash checks pass.
- **Phase 35 Ingestion**: **QUARANTINED** (`replayValid: false`, `reasonCodes: ["REPLAY_VERIFICATION_FAILURE"]`).
- **Conclusion**: Phase 35 fourfold outcome derivation independently calculates `derivedTerminalOutcome = "FAILED"` from attempt exit codes, catching false claims regardless of signature validity.
- **Classification**: **DEMONSTRATED**.

### Attack A4: Replay-Valid but Policy-Invalid Evidence
- **Setup**: Attacker validly signs an internally consistent bundle containing unredacted raw credentials (`{ raw_password: "unredacted-secret-password-123" }`) in an action input payload.
- **Phase 35 Ingestion**: **QUARANTINED** (`replayValid: true`, `reasonCodes: ["SECURITY_POLICY_FAILURE"]`).
- **Conclusion**: Cryptographic signatures do not bypass security policies. Ingestion enforces conjunction: `ValidSignature ∧ ValidReplay ∧ ValidPolicy`.
- **Classification**: **DEMONSTRATED**.

### Attack A5: Revoked Producer Authority
- **Setup**: Key `producer-key` is revoked in `TrustedKeyring`. Attacker attempts to submit a new bundle signed by the revoked key; verifier subsequently re-verifies a historically archived bundle signed prior to revocation.
- **Phase 35 Ingestion**: New submission is **QUARANTINED** (`reasonCodes: ["REVOKED_SIGNING_KEY"]`). Historical bundle remains **VERIFIED** (`authorityStatus: "REVOKED"`).
- **Classification**: **DEMONSTRATED**.

### Attack A6: Supervisor Disagreement
- **Setup**: Producer signs a bundle as verified. An independent supervisor refuses to endorse it (or issues an invalid signature).
- **2-of-2 Quorum**: **REJECTED** (`MISSING_REQUIRED_AUTHORITY: supervisor-key`). Admission halts (deadlock).
- **2-of-3 Threshold**: **ACCEPTED** if an independent witness authority provides the second valid signature.
- **Conclusion**: Strict 2-of-2 consensus trades availability for safety. A threshold model (2-of-3) prevents a single uncooperative authority from deadlocking valid evidence admission.
- **Classification**: **DEMONSTRATED**.

### Attack A7: Conflicting Valid Evidence for Same RunId
- **Setup**: Two valid bundles for the same `runId` are exported at different times ($T_1$ and $T_2$) and signed by the producer key.
- **Phase 35 Ingestion**: Both Bundle A and Bundle B are **ACCEPTED** under distinct `bundleId`s. Content addressing stores both without enforcing terminal outcome uniqueness per `runId`.
- **Hypothetical Quorum**: A multi-authority endorsement over a specific `bundleId` enforces consensus on a single canonical bundle for the run.
- **Classification**: **DEMONSTRATED**.

### Attack A8: Signature Stripping
- **Setup**: The signature field is removed from a valid bundle. Submitted under `allowUnsignedLegacy = false` (strict) and `allowUnsignedLegacy = true` (legacy).
- **Strict Mode**: **QUARANTINED** (`reasonCodes: ["UNSIGNED_BUNDLE_REJECTED"]`).
- **Legacy Mode**: **ACCEPTED** (`signatureStatus: "UNSIGNED_LEGACY"`, `authorityStatus: "NOT_ESTABLISHED"`).
- **Classification**: **DEMONSTRATED**.

### Attack A9: Signature Substitution
- **Setup**: Genuine signature replaced with signature from an unknown key, or with mismatched signature bytes from another keypair.
- **Unknown Key**: **QUARANTINED** (`reasonCodes: ["UNKNOWN_SIGNING_KEY"]`).
- **Mismatched Signature**: **QUARANTINED** (`reasonCodes: ["INVALID_SIGNATURE"]`).
- **Classification**: **DEMONSTRATED**.

### Attack A10: Keyring Compromise
- **Setup**: Adversary subverts the verifier's `TrustedKeyring` and registers arbitrary rogue keys as `TRUSTED`.
- **Single Authority**: **ACCEPTED**.
- **Multi-Authority Quorum**: **ACCEPTED**. Adversary registers multiple rogue keys and signs with all of them, satisfying the quorum threshold.
- **Conclusion**: Multi-authority quorum provides **zero** protection against trust-root compromise. The security boundary remains anchored to local keyring integrity.
- **Classification**: **DEMONSTRATED**.

### Attack A11: One Malicious Authority in 2-of-3 Model
- **Setup**: Authorities A and B are honest; Authority C emits a corrupt signature.
- **Quorum Result**: **ACCEPTED** (`distinctValidSignatures: 2`, `rejectedKeyIds: ["witness-key"]`).
- **Conclusion**: 2-of-3 threshold maintains availability in the presence of one faulty authority while enforcing 2 independent honest endorsements.
- **Classification**: **DEMONSTRATED**.

### Attack A12: Two Conflicting Honest Authorities
- **Setup**: Authority A signs; Authority B experiences a verification timeout and withholds endorsement.
- **2-of-2 Model**: **REJECTED** (`QUORUM_NOT_MET: required 2, got 1`).
- **Conclusion**: Demonstrates liveness failure and deadlock in non-deterministic distributed verification environments.
- **Classification**: **DEMONSTRATED**.

### Attack A13: Duplicate Authority Signatures
- **Setup**: Adversary submits two copies of Authority A's valid signature to satisfy a 2-of-3 quorum threshold.
- **Quorum Result**: **REJECTED** (`distinctValidSignatures: 1`, `QUORUM_NOT_MET: required 2, got 1`).
- **Conclusion**: Quorum logic must enforce distinct authority identities; replaying signatures from a single authority cannot satisfy multi-authority thresholds.
- **Classification**: **DEMONSTRATED**.

### Attack A14: Historical Revocation
- **Setup**: Key revoked after bundle is archived. Verification executed against archived bundle.
- **Result**: **VERIFIED** (`signatureStatus: "VALID"`, `authorityStatus: "REVOKED"`).
- **Classification**: **DEMONSTRATED**.

### Attack A15: Deterministic Attack Replay
- **Setup**: Ingestion evaluated across 5 repeated trials with fresh gateways and archives.
- **Result**: 5/5 trials returned identical `ACCEPTED:VALID:TRUSTED` outcomes.
- **Classification**: **DEMONSTRATED**.

---

## 5. Phase 35 Security Matrix

| Attack Scenario | Attacker Capability | Replay Catches? | Signature Catches? | Phase 35 Outcome |
|:---|:---|:---:|:---:|:---:|
| **A1: Compromised Producer Key** | Signs arbitrary synthetic bundle | FAIL | FAIL | **FAIL** (Vulnerability) |
| **A2: Malicious Validly Signed Bundle** | Signs false `COMPLETED` claim | PASS | NOT_APPLICABLE | **PASS** (Quarantined) |
| **A3: Valid Sig + False Outcome** | Signs failed command with completion claim | PASS | NOT_APPLICABLE | **PASS** (Quarantined) |
| **A4: Policy Violation (Secret Leak)** | Signs bundle containing unredacted secret | NOT_APPLICABLE | NOT_APPLICABLE | **PASS** (Quarantined) |
| **A5: Revoked Producer Authority** | Signs with revoked key | NOT_APPLICABLE | PASS | **PASS** (Quarantined) |
| **A6: Supervisor Disagreement** | Producer signs unilaterally | NOT_APPLICABLE | NOT_APPLICABLE | **FAIL** (Accepted unilaterally) |
| **A7: Conflicting Valid Bundles** | Signs 2 divergent bundles for same runId | NOT_APPLICABLE | NOT_APPLICABLE | **FAIL** (Both accepted) |
| **A8: Signature Stripping** | Strips signature block | NOT_APPLICABLE | PASS | **PASS** (Quarantined in strict) |
| **A9: Signature Substitution** | Swaps unknown key or bogus signature | NOT_APPLICABLE | PASS | **PASS** (Quarantined) |
| **A10: Keyring Compromise** | Injects rogue keys into trusted keyring | FAIL | FAIL | **FAIL** (Trust-root limit) |
| **A11: Malicious Authority (1-of-1)** | Producer key compromised | FAIL | FAIL | **FAIL** |
| **A12: Conflicting Evaluators** | Single authority evaluates | NOT_APPLICABLE | NOT_APPLICABLE | **NOT_APPLICABLE** |
| **A13: Duplicate Signatures** | Replays single signature | NOT_APPLICABLE | NOT_APPLICABLE | **NOT_APPLICABLE** |
| **A14: Historical Revocation** | Audits past bundle after revocation | PASS | PASS | **PASS** (Verified with REVOKED) |
| **A15: Deterministic Attack Replay** | Re-executes identical ingestion trials | PASS | PASS | **PASS** (100% deterministic) |

---

## 6. Hypothetical Quorum Security Matrix

| Attack Scenario | Phase 35 | Hypothetical Quorum | Replay Catches? | Signature Catches? | Quorum Adds Value? |
|:---|:---:|:---:|:---:|:---:|:---:|
| **A1: Compromised Producer Key** | FAIL | **PASS** | FAIL | PASS (Supervisor required) | **PASS** (Closes concrete gap) |
| **A2: Malicious Validly Signed Bundle** | PASS | PASS | PASS | NOT_APPLICABLE | **NOT_APPLICABLE** (Replay already catches) |
| **A3: Valid Sig + False Outcome** | PASS | PASS | PASS | NOT_APPLICABLE | **NOT_APPLICABLE** (Replay already catches) |
| **A4: Policy Violation (Secret Leak)** | PASS | PASS | NOT_APPLICABLE | NOT_APPLICABLE | **NOT_APPLICABLE** (Policy already catches) |
| **A5: Revoked Producer Authority** | PASS | PASS | NOT_APPLICABLE | PASS | **NOT_APPLICABLE** (Keyring already catches) |
| **A6: Supervisor Disagreement** | FAIL | **PASS** | NOT_APPLICABLE | PASS | **PASS** (Prevents unilateral claim) |
| **A7: Conflicting Valid Bundles** | FAIL | **PASS** | NOT_APPLICABLE | PASS | **PASS** (Enforces canonical bundle consensus) |
| **A8: Signature Stripping** | PASS | PASS | NOT_APPLICABLE | PASS | **NOT_APPLICABLE** (Phase 35 already catches) |
| **A9: Signature Substitution** | PASS | PASS | NOT_APPLICABLE | PASS | **NOT_APPLICABLE** (Phase 35 already catches) |
| **A10: Keyring Compromise** | FAIL | FAIL | FAIL | FAIL | **FAIL** (Trust-root compromise limits both) |
| **A11: 1 Malicious Authority in 2-of-3**| FAIL | **PASS** | NOT_APPLICABLE | PASS | **PASS** (Provides fault-tolerant availability) |
| **A12: Conflicting Honest Authorities** | NOT_APPLICABLE | LIVENESS_FAILURE | NOT_APPLICABLE | NOT_APPLICABLE | **FAIL** (Trades availability for safety) |
| **A13: Duplicate Signatures** | NOT_APPLICABLE | **PASS** | NOT_APPLICABLE | PASS | **PASS** (Distinct identity enforced) |
| **A14: Historical Revocation** | PASS | PASS | PASS | PASS | **NOT_APPLICABLE** (Phase 35 already preserves) |
| **A15: Deterministic Replay** | PASS | PASS | PASS | PASS | **NOT_APPLICABLE** (Both 100% deterministic) |

---

## 7. Integrity vs Authenticity vs Truth Analysis

A critical finding of Phase 36 is the strict theoretical and architectural separation between security properties:

1. **Integrity (Data Hash)**: Proves that bytes have not been mutated since hash calculation ($\text{SHA-256}$).
2. **Authenticity (Signature)**: Proves that the entity signing the payload possessed the corresponding private key ($\text{Ed25519}$). It does **not** prove that the statements made in the payload are true.
3. **Replay Validity (Consistency)**: Proves that the recorded events, attempts, and checkpoints satisfy internal causal and transition rules.
4. **Policy Validity (Compliance)**: Proves that recorded actions do not violate organizational constraints (e.g., unauthorized capabilities, secret exposure).
5. **Operational Truth (Physical Execution)**: Proves that the claimed actions actually took place on genuine physical execution environments. Single-authority signing cannot prove operational truth if the producer is compromised (A1).
6. **Independent Verification (Quorum Endorsement)**: Proves that at least two independent processes (e.g., Worker Runtime and Supervisor) co-attest to the execution trajectory.
7. **Authority Agreement (Consensus)**: Proves that independent evaluators reached identical conclusions regarding the outcome.
8. **Availability**: The ability of the ingestion boundary to accept legitimate evidence despite one authority being offline or unreachable.
9. **Trust-Root Security**: The assumption that the local public keyring has not been tampered with.

---

## 8. Demonstrated Security Gaps

Phase 36 demonstrated two concrete security gaps in Phase 35:

### Gap 1: Unilateral Producer Synthetic Evidence Fabrication (A1)
- **Observation**: An adversary holding the worker producer key can construct a completely synthetic `EvidenceBundle` containing fake commands, fake outputs, and fake exit codes. Because all internal hashes and event chains can be computed deterministically offline, the bundle is replay-valid.
- **Phase 35 Behavior**: Accepted without warning.
- **Quorum Impact**: Materially closed by requiring co-endorsement from an independent supervisor who observes execution via heartbeat leasing.

### Gap 2: Multi-Bundle RunId Conflict Blindness (A7)
- **Observation**: Phase 35 content-addresses bundles strictly by `bundleId = sha256(content)`. If a producer emits two contradictory valid bundles for the same `runId` (e.g., one claiming success, one claiming failure), both are accepted and archived.
- **Phase 35 Behavior**: No conflict detection across bundles sharing the same `runId`.
- **Quorum Impact**: Materially closed by requiring quorum consensus over a single canonical `bundleId` for each `runId`.

---

## 9. Demonstrated Benefits of Quorum

1. **Defense-in-Depth Against Worker Process Compromise**: In autonomous software engineering architectures, worker containers have broad filesystem and shell capabilities, making them the most vulnerable component. Multi-authority quorum ensures that compromising a worker's private key is insufficient to forge accepted evidence.
2. **Dual-Signer Attestation (Worker + Supervisor)**: Enforces that evidence must be endorsed by both the worker (which executed the action) and the supervisor (which monitored worker heartbeats and fenced leases).
3. **Byzantine Fault Tolerance (2-of-3 Model)**: Demonstrates that a 2-of-3 threshold maintains ingestion availability when one authority experiences a transient fault or key compromise, without relaxing the requirement for 2 independent endorsements.

---

## 10. Complexity Introduced by Quorum

While quorum provides distinct security benefits, it introduces measurable engineering overhead:

1. **Threshold & Authority Cardinality Management**: Requires managing committee definitions, minimum thresholds ($K$), and authority roles (e.g., `PRODUCER`, `SUPERVISOR`, `WITNESS`).
2. **Signature Accumulation Latency**: Evidence bundles cannot be finalized instantaneously upon run completion; they must await asynchronous endorsement signatures from secondary authorities.
3. **Deadlock & Liveness Risks (A6, A12)**: In strict $M$-of-$M$ policies, a single offline or disagreeing authority causes indefinite ingestion blockage.
4. **Storage Inflation**: Multi-signature arrays increase bundle size proportional to committee cardinality $M$.

---

## 11. Trust-Root Analysis

Attack A10 experimentally established the fundamental limit of multi-authority signing:
- If an adversary achieves write access to the verifier's local `TrustedKeyring`, they can register $M$ rogue public keys as `TRUSTED`.
- The adversary can then sign synthetic bundles with all $M$ rogue private keys, satisfying any $K$-of-$M$ quorum threshold.
- **Conclusion**: Quorum signing protects against **producer/worker key compromise**, but provides **zero protection against trust-root compromise**. Trust root security must be maintained through host-level filesystem permissions and immutable OS-level deployment controls.

---

## 12. Availability Analysis

The evaluation compared strict $2$-of-$2$ consensus against threshold $2$-of-$3$ consensus:

| Architecture | 0 Authorities Faulty | 1 Authority Faulty / Offline | 1 Authority Malicious | Disagreement Handling |
|:---|:---:|:---:|:---:|:---:|
| **Single Authority (Phase 35)** | Available | Unavailable | Accepts Forgery (A1) | N/A (Unilateral) |
| **Strict 2-of-2 (Worker + Supervisor)**| Available | **Unavailable (Deadlock)** | **Protected (Quarantine)** | **Deadlock (A6, A12)** |
| **Threshold 2-of-3 (Committee)** | Available | **Available (A11)** | **Protected (A11)** | **Majority Decides** |

Strict 2-of-2 maximizes safety at the expense of availability. Threshold 2-of-3 provides the optimal Pareto balance between forgery resistance and operational availability.

---

## 13. Historical Revocation Analysis

Attacks A5 and A14 confirmed that key revocation semantics operate cleanly:
- Revoking an authority halts acceptance of new incoming bundles signed by that authority (`REVOKED_SIGNING_KEY`).
- Historical bundles archived prior to revocation remain verifiable via `archive.verifyArchivedBundle()`, reporting `signatureStatus: "VALID"` and `authorityStatus: "REVOKED"`.
- This ensures that rotating or revoking compromised worker keys does not invalidate past evidence records.

---

## 14. Evidence Limitations

1. **In-Process Single-Host Evaluation**: While simulated with independent keys and isolated gateway instances, the evaluation was conducted on a single host without real network delays.
2. **Supervisor Co-Signing Mechanism**: Phase 36 evaluated the cryptographic properties of multi-signature bundles; it did not specify the physical transport protocol by which a supervisor inspects execution state before affixing its signature.
3. **No External PKI**: The evaluation strictly conforms to Emerald's ₹0, local-only constraints, avoiding reliance on external certificate authorities, timestamping authorities, or cloud KMS.

---

## 15. Recommendation

Based on the Information-Gain Rule:
> "Only recommend Phase 37 if this phase demonstrates at least one of:
> 1. a concrete authority-confusion vulnerability
> 2. a concrete producer-compromise gap that independent authorities materially close
> 3. a concrete evidence-truth gap that replay/policy/signature alone cannot close but independent endorsement can
> 4. a measurable security property unavailable under single-authority signing"

Phase 36 demonstrated:
1. **Concrete Producer Compromise Gap (A1)**: A compromised worker key allows unilateral fabrication of synthetic evidence accepted by Phase 35. Quorum requiring independent supervisor endorsement directly closes this gap.
2. **RunId Outcome Ambiguity (A7)**: Phase 35 cannot resolve divergent bundles for the same `runId`. Multi-authority quorum over `bundleId` enforces canonical outcome consensus.

Therefore, the research formally recommends proceeding with Phase 37 implementation.

---

## 16. Exact Next Phase Decision

RECOMMENDATION: IMPLEMENT_PHASE37

### Evidence Summary
1. **Concrete Producer Compromise Gap Demonstrated (A1)**: In Phase 35, an attacker possessing the worker producer private key successfully forged an internally consistent synthetic run that passed all signature, replay, and policy checks (`status: ACCEPTED`). Requiring a 2-of-2 supervisor co-signature rejected the forgery (`MISSING_REQUIRED_AUTHORITY: supervisor-key`), proving that multi-authority signing closes a vulnerability unaddressed by single-authority signing.
2. **Replay vs Authenticity Property Separation Proven (A2, A3)**: Replay verification was proven to independently detect falsified completion claims (`status: QUARANTINED`) regardless of valid cryptographic signatures, confirming that signatures establish identity rather than truthfulness.
3. **RunId Divergence Blindness Demonstrated (A7)**: Phase 35 content-addressed archival was shown to accept two contradictory valid bundles for the same logical `runId` under different `bundleId`s. Quorum signing over canonical bundle identity resolves this conflict.
4. **Availability vs Safety Pareto Frontier Established (A6, A11, A12)**: Evaluation proved that while strict 2-of-2 consensus deadlocks under evaluator disagreement, a 2-of-3 threshold maintains availability in the presence of one faulty authority while preventing unilateral fabrication.
5. **Trust-Root Boundary Formally Delimited (A10)**: Evaluation proved that multi-authority quorum cannot defend against local keyring compromise, establishing that quorum's scope is strictly worker/producer compromise defense.
