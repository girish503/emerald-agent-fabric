# Phase 34 — Cross-Host Evidence Ingestion & Archival Integrity Boundary
## Comprehensive Research & Implementation Report

---

### 1. Baseline
- **Frozen Commit Baseline**: `70979cf4bcbf4a237b79af3a23449a4b932104d5`
- **Preceding Phase Context**:
  - Phase 31 established deterministic multi-attempt recovery and durable worker lease fencing.
  - Phase 32 implemented mission contract checkpointing, supervisor heartbeats, and fail-closed fence transitions.
  - Phase 33 implemented governed clean-room replay verification and cryptographic evidence bundle export (`EvidenceBundle`, `EvidenceExporter`, `EvidenceReplayVerifier`).
- **Phase 34 Objective**: Extend Phase 33's evidence verification into a cross-host, untrusted evidence-ingestion gateway and immutable content-addressed archival system without granting the ingestion verifier direct access to the producing host's SQLite database, filesystem, worker runtime, Docker environment, models, or network.
- **Cost**: ₹0. Local-only execution, zero paid cloud or proprietary APIs, zero model downloads, zero Ollama inference.

---

### 2. Trust Boundary
The fundamental premise of Phase 34 is that evidence crossing host boundaries is **untrusted data**.
- **Untrusted Elements**:
  - Raw JSON bytes, network payloads, or disk transfer files.
  - Producer-declared identifiers (`bundleId`, `provenanceRoot`, `runId`).
  - Producer-declared status flags (`bundle.run.status`, `bundle.terminalState.status`).
  - Producer-asserted outcomes (e.g. claims that all tests passed, goals were achieved, or policies satisfied).
  - File names, directory hints, or path strings sent by the producer.
- **Trusted Elements**:
  - Receiving host's deterministic ingestion pipeline (`EvidenceIngestionGateway`).
  - RFC-8785 canonical JSON serializer (`canonicalJsonStringify`).
  - Cryptographic hash functions (SHA-256).
  - Pure in-memory replay verifier (`EvidenceReplayVerifier`).
  - Receiving host's immutable content-addressed archive (`FileSystemEvidenceArchive`).
- **Complete Decoupling**: The verifier neither requires nor possesses:
  - Database access to the producer's SQLite instance.
  - Network sockets or RPC connections to the producer's supervisor or workers.
  - Host OS access or Docker daemon access to the producer's container sandbox.
  - Model credentials, Ollama API access, or execution permissions.

---

### 3. Existing Semantics
Phase 34 builds upon the audited invariants from Phase 34A (`scratch/phase34-current-semantics.md`):
- **Canonical Serialization**: Serialization determinism is enforced via RFC-8785 canonical JSON representation (`canonicalJsonStringify`), ensuring lexicographical key ordering, array stability, and explicit null preservation.
- **Size Bounds**: Payloads are strictly gated at 10 MB (`10 * 1024 * 1024` bytes) prior to parsing, defending against parser bombs and memory exhaustion.
- **Independent Derivation**: The receiving verifier never trusts producer assertions. It independently recomputes `contract.contentHash`, event hash chains, `provenanceRoot`, `bundleId`, fourfold completion (`taskSatisfied`, `verificationPassed`, `policySatisfied`, `evidenceComplete`), and terminal outcome (`COMPLETED` vs `FAILED`).
- **Fail-Closed Processing**: Any defect, schema deviation, hash mismatch, sequence gap, or tampering immediately halts verification and routes the bundle to quarantine.

---

### 4. Ingestion Gateway
The `EvidenceIngestionGateway` (`src/application/evidence-ingestion-gateway.ts`) orchestrates the untrusted ingestion pipeline:
```
Raw Payload (String / Buffer)
  ↓ [1. Size Gating (< 10 MB)]
JSON Parser
  ↓ [2. Parse Validation (Valid JSON Object)]
Structural Schema Validator
  ↓ [3. Format & Schema Verification (emerald-evidence-bundle-v1, schemaVersion=1)]
Security Policy Scanner
  ↓ [4. Secret Redaction Audit (No unredacted credentials)]
Bundle ID & Root Recalculation
  ↓ [5. Cryptographic Check (declared == recomputed)]
Offline Replay Verifier
  ↓ [6. Deterministic Replay (Fourfold check, hash chain, authority, attempts)]
Archive Collision / Duplicate Check
  ↓ [7. Storage Audit (Duplicate vs Identity Conflict vs Fresh)]
Content-Addressed Archival
  ↓ [8. Write to archive/accepted/<bundleId>.json]
Ingestion Result (ACCEPTED | DUPLICATE | QUARANTINED)
```
Every step is strictly fail-closed: failures at any stage immediately terminate further evaluation and commit the payload to isolated quarantine.

---

### 5. Bundle Validation
Before any cryptographic or replay analysis occurs, the raw payload undergoes structural verification:
- **Pre-Parse Size Check**: Reject payloads > 10,485,760 bytes with `BUNDLE_TOO_LARGE`.
- **JSON Parse Check**: Reject malformed syntax with `INVALID_JSON`.
- **Root Object Check**: Ensure payload is a non-null JSON object, not an array or primitive.
- **Format Identity**: Ensure `formatVersion === "emerald-evidence-bundle-v1"`.
- **Schema Version**: Ensure `schemaVersion === 1`.
- **Structural Completeness**: Validate presence and types of all required top-level members:
  - `run`: Object with `runId`, `status`, `createdAt`, `updatedAt`.
  - `contract`: Object with `contractId`, `spec`, `contentHash`, `status`.
  - `checkpoints`: Array of checkpoint objects.
  - `events`: Array of chained domain event objects.
  - `actions`: Array of action snapshot objects.
  - `attempts`: Array of attempt snapshot objects.
  - `supervisorEvidence`: Array of supervisor authority lease objects.
  - `verificationEvidence`: Array of evidence objects.
  - `verificationResults`: Array of verification evaluations.
  - `terminalState`: Object with `status` and `terminalReason`.
  - `provenance`: Object with `exportedAt`, `exporterVersion`.
  - `bundleId`: String.
  - `provenanceRoot`: String.

---

### 6. Cryptographic Validation
Cryptographic validation guarantees data integrity across the entire bundle structure:
1. **Contract Content Hash**:
   $$\text{recomputedContractHash} = \text{computeCanonicalHash}(\text{bundle.contract.spec})$$
   Validated against `bundle.contract.contentHash`.
2. **Subsystem Provenance Roots**:
   - `contractHash`: Validated against contract spec hash.
   - `eventRoot`: Validated as SHA-256 of the terminal event hash (or genesis if empty).
   - `checkpointRoot`: Validated as SHA-256 of ordered checkpoint hashes.
   - `attemptRoot`: Validated as SHA-256 of ordered attempt hashes.
   - `verificationRoot`: Validated as SHA-256 of ordered verification evidence hashes.
3. **Provenance Root**:
   $$\text{recomputedProvenanceRoot} = \text{computeProvenanceRoot}(\text{subsystems})$$
   Validated against `bundle.provenanceRoot`.
4. **Bundle Identifier**:
   $$\text{recomputedBundleId} = \text{computeBundleId}(\text{bundleContent without bundleId})$$
   Validated against `bundle.bundleId`.
Any discrepancy triggers immediate quarantine with specific codes (`INVALID_BUNDLE_ID`, `INVALID_PROVENANCE_ROOT`, `CONTRACT_INTEGRITY_FAILURE`, etc.).

---

### 7. Replay Validation
The ingestion gateway invokes the pure, offline `EvidenceReplayVerifier` (`src/application/evidence-replay-verifier.ts`):
- **Cryptographic Event Hash Chain**: Recomputes every link in the event chain from genesis:
  $$e_1.\text{previousEventHash} = \text{SHA256}(\text{"genesis:"} + \text{runId})$$
  $$e_i.\text{previousEventHash} = e_{i-1}.\text{eventHash} \quad (i > 1)$$
  Confirms sequence numbers are strictly contiguous ($1..M$) with zero gaps.
- **Historical Attempt Monotonicity**: Verifies attempt numbers are strictly sequential ($1..K$), attempts are historically immutable, and actions reference valid attempts.
- **Supervisor Authority Leases**: Verifies that any supervisor state transition was authorized by an active, unexpired, non-fenced supervisor lease.
- **Fourfold Completion Derivation**: Independently derives the fourfold completion predicates:
  - `taskSatisfied`: Whether the contract spec objectives and exit criteria were fulfilled.
  - `verificationPassed`: Whether all required verification gates passed without failure.
  - `policySatisfied`: Whether reflex and governance policies approved all executed actions.
  - `evidenceComplete`: Whether required evidence records were durably captured.
- **Terminal State Reconciliation**: Compares derived terminal outcome against the producer's declared status. If the producer claimed `COMPLETED` when verification failed, replay rejects the bundle with `REPLAY_VERIFICATION_FAILURE`.

---

### 8. Acceptance Semantics
A bundle is designated **`ACCEPTED`** if and only if all of the following conditions are simultaneously met:
1. Raw payload length $\le 10,485,760\text{ bytes}$.
2. Valid JSON parse without syntax errors.
3. Strict structural schema conformance to `emerald-evidence-bundle-v1`.
4. Zero unredacted credentials or sensitive tokens detected.
5. Declared `bundleId` exactly matches independently recomputed content digest.
6. Declared `provenanceRoot` exactly matches independently recomputed subsystem root.
7. Replay verifier succeeds with `valid === true`.
8. No identity conflict exists in the content-addressed archive.
9. Bundle is successfully written to `archive/accepted/<bundleId>.json`.

---

### 9. Duplicate Handling
Duplicate handling is strictly idempotent:
- When a valid bundle is submitted whose `bundleId` matches an existing entry in `archive/accepted/`:
  - The gateway retrieves the existing canonical serialization from the archive.
  - It compares the existing bytes to the incoming canonical bytes.
  - If identical, the gateway returns status **`DUPLICATE`**.
  - **Zero disk writes occur.** No redundant files or temporary duplicates are created.
  - The existing archive file is retained untouched.

---

### 10. Identity Conflict Handling
An identity conflict represents either an active collision attack, tampering attempt, or ID spoofing:
- Occurs when an incoming bundle produces or declares a `bundleId` identical to an existing archived bundle, but its canonical bytes differ:
  $$\text{incomingCanonicalBytes} \neq \text{archivedCanonicalBytes}$$
- The ingestion gateway classifies this as **`IDENTITY_CONFLICT`**.
- The incoming conflicting bundle is immediately routed to `archive/quarantine/IDENTITY_CONFLICT/<quarantineId>.json`.
- The existing archived artifact in `archive/accepted/<bundleId>.json` is strictly protected and **never overwritten**.

---

### 11. Quarantine Semantics
Quarantined payloads are isolated to prevent archive contamination:
- **Location**: `archive/quarantine/<reasonCode>/<quarantineId>.json`.
- **Reason Taxonomy**:
  - `BUNDLE_TOO_LARGE`: Payload exceeds 10 MB limit.
  - `INVALID_JSON`: Malformed JSON syntax or non-object root.
  - `UNSUPPORTED_SCHEMA`: Missing required fields, invalid types, or unsupported version.
  - `INVALID_BUNDLE_ID`: Mismatch between declared and recomputed bundle ID.
  - `INVALID_PROVENANCE_ROOT`: Mismatch between declared and recomputed provenance root.
  - `CONTRACT_INTEGRITY_FAILURE`: Contract spec hash mismatch or tampering.
  - `EVENT_INTEGRITY_FAILURE`: Broken event hash chain, sequence gaps, or event deletion.
  - `CHECKPOINT_INTEGRITY_FAILURE`: Checkpoint sequence or hash mismatch.
  - `ATTEMPT_INTEGRITY_FAILURE`: Attempt numbering gaps, mutation, or status tampering.
  - `AUTHORITY_INTEGRITY_FAILURE`: Unfenced or invalid supervisor lease transitions.
  - `VERIFICATION_INTEGRITY_FAILURE`: Verification evidence hash discrepancy.
  - `REPLAY_VERIFICATION_FAILURE`: Semantic replay failure or false outcome claim.
  - `IDENTITY_CONFLICT`: Canonical byte mismatch against existing archived bundle ID.
  - `SECURITY_POLICY_FAILURE`: Detected unredacted raw credentials in bundle payload.
- **Isolation Guarantee**: Quarantined files are never returned by archive lookups, never treated as verified evidence, and cannot be retrieved through accepted bundle APIs.

---

### 12. Archive Design
The `FileSystemEvidenceArchive` (`src/adapters/persistence/file-system-evidence-archive.ts`) implements `EvidenceArchivePort`:
- **Directory Layout**:
  ```
  archiveRoot/
  ├── accepted/
  │   └── <bundleId>.json         # 64-character lowercase hex digest
  └── quarantine/
      └── <reasonCode>/
          └── <quarantineId>.json # Timestamp + sanitized random hex ID
  ```
- **Path Sanitization & Injection Prevention**:
  - All filenames in `accepted/` are validated against strict regex: `^[0-9a-f]{64}$`.
  - Directory traversal sequences (`..`, `/`, `\`) or arbitrary user-controlled strings are rejected with runtime errors.
- **Content-Addressed Immutability**:
  - Accepted bundles are stored using `bundleId` as the filename.
  - If an existing file exists at `archive/accepted/<bundleId>.json`, overwriting is strictly disallowed.
  - Once written, files are marked read-only on supporting filesystems.

---

### 13. Archive Re-Verification
Archived evidence must remain independently verifiable at any future time:
- The archive provides `verifyArchivedBundle(bundleId)`.
- It reads the archived JSON file from `archive/accepted/<bundleId>.json`.
- It recalculates the content hash of the stored file.
- It re-runs the full `EvidenceReplayVerifier.verify(bundle)`.
- If the file on disk has been modified or corrupted, re-verification detects the tamper immediately, reporting `tampered: true` and `valid: false`.

---

### 14. Cross-Host Simulation
Test T21 explicitly simulates cross-host transmission:
1. **Producer Host Execution**:
   - Host A executes a mission to completion in its own SQLite database and workspace.
   - Host A calls `EvidenceExporter.exportBundle(runId)` and serializes the bundle to a standalone JSON file.
2. **Physical Boundary Crossing**:
   - The serialized JSON string is transferred across an air-gapped simulated boundary.
   - Host A's SQLite database, memory state, and workspace are completely deleted.
3. **Consumer Host Ingestion**:
   - Host B initializes a fresh `FileSystemEvidenceArchive` and `EvidenceIngestionGateway`.
   - Host B receives the raw payload bytes without any access to Host A.
   - Host B validates, verifies, and accepts the bundle into its own content-addressed archive.
   - Host B independently executes `verifyArchivedBundle(bundleId)` to confirm archival integrity.

---

### 15. Security Analysis
- **Parser Hardening**: 10 MB pre-parse size limit prevents DoS / memory exhaustion attacks.
- **Path Traversal Protection**: Archive paths are constructed solely from verified 64-character hex digests (`^[0-9a-f]{64}$`), eliminating directory traversal vulnerabilities.
- **Secret Scrubbing**: `containsUnredactedSecrets` scans recursive payloads for raw credentials (`password`, `secret`, `token`, `api_key`, `access_key`, `private_key`), rejecting unredacted secrets with `SECURITY_POLICY_FAILURE` while preserving operational tokens (`idempotencyToken`, `credentialScopes`).
- **Archive Poisoning Resistance**: Existing archived records are strictly immutable. Identity collision attempts cannot overwrite accepted evidence.
- **Zero-Execution Sandbox**: Ingestion and replay verifier execute zero shell commands, zero candidate patches, zero dynamic JavaScript (`eval`), and zero model calls.

---

### 16. Test Matrix
All 25 integration tests in `tests/integration/phase34-evidence-ingestion.test.ts` passed (100%):

| Test ID | Description | Scenario / Invariant | Status |
| :--- | :--- | :--- | :--- |
| **T1** | Valid bundle accepted | Full valid bundle accepted and written to `archive/accepted/<bundleId>.json` | **PASS** |
| **T2** | Malformed JSON quarantined | Syntax error in JSON string quarantined with `INVALID_JSON` | **PASS** |
| **T3** | Oversized bundle quarantined | Payload exceeding 10 MB rejected prior to parse with `BUNDLE_TOO_LARGE` | **PASS** |
| **T4** | Unsupported schema quarantined | Missing required fields or wrong formatVersion quarantined with `UNSUPPORTED_SCHEMA` | **PASS** |
| **T5** | Invalid bundleId quarantined | Forged or mutated `bundleId` quarantined with `INVALID_BUNDLE_ID` | **PASS** |
| **T6** | Invalid provenanceRoot quarantined | Forged `provenanceRoot` quarantined with `INVALID_PROVENANCE_ROOT` | **PASS** |
| **T7** | Contract tampering quarantined | Spec modification without matching contentHash triggers `CONTRACT_INTEGRITY_FAILURE` | **PASS** |
| **T8** | Event deletion quarantined | Dropped intermediate event breaks sequence and triggers `EVENT_INTEGRITY_FAILURE` | **PASS** |
| **T9** | Event reordering quarantined | Swapped event order breaks hash chain and triggers `EVENT_INTEGRITY_FAILURE` | **PASS** |
| **T10** | Attempt mutation quarantined | Mutated attempt status or exitCode triggers `ATTEMPT_INTEGRITY_FAILURE` | **PASS** |
| **T11** | Checkpoint mutation quarantined | Mutated checkpoint state triggers `CHECKPOINT_INTEGRITY_FAILURE` | **PASS** |
| **T12** | Verification evidence mutation | Mutated test failure count triggers `VERIFICATION_INTEGRITY_FAILURE` | **PASS** |
| **T13** | False success bundle quarantined | Stated `COMPLETED` on failed verification triggers `REPLAY_VERIFICATION_FAILURE` | **PASS** |
| **T14** | Duplicate submission idempotent | Re-submitting identical bundle returns `DUPLICATE` with zero duplicate writes | **PASS** |
| **T15** | Identity conflict quarantined | Re-submitting same `bundleId` with different content triggers `IDENTITY_CONFLICT` | **PASS** |
| **T16** | Archive re-verification PASS | Unmodified archived bundle re-verifies cleanly offline | **PASS** |
| **T17** | Archive tampering detection | In-place disk mutation of archived file is caught by `verifyArchivedBundle` | **PASS** |
| **T18** | Quarantine isolation verified | Quarantined bundles are segregated and never accessible via accepted APIs | **PASS** |
| **T19** | Producer runtime destroyed | Ingestion and re-verification succeed even after producer DB is wiped | **PASS** |
| **T20** | Multi-gateway single archive | Multiple concurrent gateways targeting one archive maintain identical state | **PASS** |
| **T21** | Cross-host file transfer simulation | Full end-to-end simulated cross-host export, transfer, wipe, and ingest | **PASS** |
| **T22** | Prohibited secret policy | Unredacted raw credentials in bundle trigger `SECURITY_POLICY_FAILURE` | **PASS** |
| **T23** | Idempotency token preservation | Safe operational tokens (`idempotencyToken`) are preserved and accepted | **PASS** |
| **T24** | Ingestion determinism | Repeated ingestion of same payload produces deterministic results | **PASS** |
| **T25** | Zero execution guarantee | Zero child processes, tools, models, or network connections invoked | **PASS** |

---

### 17. Regression Results
Complete regression suite executed cleanly:
- `tests/integration/phase34-evidence-ingestion.test.ts`: **25/25 PASSED**
- `tests/integration/phase33-evidence-replay.test.ts`: **23/23 PASSED**
- `tests/persistence/phase32-contract-checkpoint-supervisor.test.ts`: **24/24 PASSED**
- `tests/persistence/phase31-recovery-fencing.test.ts`: **18/18 PASSED**
- `tests/integration/phase14-independent-verification.test.ts`: **11/11 PASSED**
- Full integration test suite: **131 passed, 1 skipped** (Ollama offline per constraints)
- Historical test artifacts (`scripts/verify-phase10h-artifacts.ts`): **36/36 intact**
- TypeScript type-check (`npx tsc --noEmit`): **CLEAN (0 errors)**
- Git diff whitespace check (`git diff --check`): **CLEAN (0 warnings)**

---

### 18. Failure Classification
Zero failures observed during Phase 34 execution:
- Transient Failures: 0
- Permanent Failures: 0
- Policy Denied Failures: 0
- Replay / Verification Failures: 0
- Regression Failures: 0

---

### 19. Remaining Risks & Negative Claims
1. **Physical Execution Boundary**: Replay verification proves structural and cryptographic consistency with recorded evidence; it does NOT physically re-execute tool actions or claim external physical truth outside recorded data.
2. **Digital Signatures**: Phase 34 implements content-addressed integrity hashing (SHA-256) and tamper-evident provenance. It does NOT implement public-key asymmetric cryptographic signatures (e.g. Ed25519) or PKI authority validation.
3. **Distributed Coordination**: Phase 34 provides cross-host evidence ingestion and archival; it does NOT implement distributed consensus (Raft/Paxos) or cross-node live worker orchestration.

---

### 20. Scientific / Architectural Conclusion
Emerald Phase 34 proves that evidence bundles generated by autonomous agent missions can safely cross trust boundaries. By decoupling evidence validation from runtime execution, the receiving system can independently verify, classify, and permanently archive software engineering mission results using pure offline cryptographic and replay analysis without exposing itself to remote execution risks, database dependencies, or model-provider coupling.

---

### 21. Phase 35 Recommendation
**Recommendation: Phase 35 — Asymmetric Cryptographic Signing & Public Key Authority Verification.**
- **Next Step**: Bind host and supervisor identities to asymmetric keypairs (Ed25519).
- **Capability**: Sign evidence bundles at export and verify producer authority at ingestion against a trusted keyring, establishing non-repudiation in addition to content integrity.
