# Phase 34A — Existing Semantics Audit
## Audit of Ingestion Boundaries, Replay Semantics, and Archival Trust Models

---

### 1. What is the Canonical Serialized Bundle Representation?
In Phase 33, `canonicalJsonStringify(value)` (defined in `src/domain/canonical-hash.ts`) was established as the authoritative serialization format for all cryptographic hashing and bundle identity.
- RFC-8785 conforming deterministic recursive lexicographical key sorting.
- Stable array element ordering.
- Explicit `null` preservation; `undefined`, functions, and symbols are omitted.
- Deterministic UTF-8 encoding.
- The canonical serialized bundle representation is a pure UTF-8 JSON string `canonicalJsonStringify(bundle)`.

---

### 2. What is the Maximum Acceptable Bundle Size?
- The Emerald runtime enforces a 1 MB boundary per individual persisted payload (`MAX_PERSISTED_PAYLOAD_BYTES = 1024 * 1024`) in SQLite.
- A complete `EvidenceBundle` aggregates the run snapshot, contract, checkpoints, chained events, actions, attempts, supervisor authority leases, and verification evidence.
- For legitimate software-engineering missions with dozens of tool actions and attempts, bundles typically range from 10 KB to 500 KB.
- To prevent memory exhaustion, Denial-of-Service (DoS), or JSON parser bombs from untrusted remote payloads, the ingestion boundary sets a deterministic maximum acceptable bundle size of **10 MB** (`10 * 1024 * 1024` bytes = 10,485,760 bytes). Bundles exceeding this ceiling are rejected immediately before JSON parsing.

---

### 3. What Fields are Independently Recomputed?
The receiving ingestion boundary and offline replay verifier independently recompute:
1. `bundleId`: Recomputed as `computeBundleId(canonicalContent)`.
2. `contract.contentHash`: Recomputed from `bundle.contract.spec` via `computeCanonicalHash`.
3. `provenanceRoot`: Recomputed from the 5 subsystem roots (`attemptRoot`, `checkpointRoot`, `contractHash`, `eventRoot`, `verificationRoot`).
4. `eventHash` & `previousEventHash`: For every event $1..M$, recomputed and chained to genesis.
5. `fourfoldOutcome`: Independently derived (`taskSatisfied`, `verificationPassed`, `policySatisfied`, `evidenceComplete`).
6. `terminalOutcome`: Independently derived from fourfold completion (`COMPLETED` vs `FAILED`).

---

### 4. What Fields are Producer Assertions?
The following incoming fields are untrusted producer claims that must NOT be trusted:
- `bundle.bundleId`: Declared bundle ID (could be fabricated or spoofed).
- `bundle.provenanceRoot`: Declared provenance root.
- `bundle.contract.contentHash`: Declared contract hash.
- `bundle.run.status`: Stated run status (e.g., claiming `COMPLETED`).
- `bundle.terminalState.status`: Producer's claim of mission outcome.
- `bundle.provenance.exportedAt`: Producer's timestamp assertion.
- `bundle.attempts[*].status`: Stated status of attempts (must match recorded exit codes and events).

---

### 5. What Exactly Constitutes an Accepted Bundle?
An evidence bundle is classified as **`ACCEPTED`** if and only if:
1. Byte length $\le 10\text{ MB}$.
2. Valid JSON parse without syntax errors.
3. Structural schema validation passes (`formatVersion === "emerald-evidence-bundle-v1"`, `schemaVersion === 1`, all required objects and arrays present).
4. `declaredBundleId === recomputedBundleId`.
5. `declaredProvenanceRoot === recomputedProvenanceRoot`.
6. `EvidenceReplayVerifier.verify(bundle)` succeeds with `valid === true`.
7. No identity conflict exists in the archive (i.e. if `bundleId` already exists, its canonical bytes must match exactly).
8. The bundle is immutably committed to the content-addressed archive (`archive/accepted/<bundleId>.json`).

---

### 6. What Exactly Constitutes a Quarantined Bundle?
An evidence bundle is classified as **`QUARANTINED`** if:
- It fails size bounds (`BUNDLE_TOO_LARGE`).
- It contains malformed JSON (`INVALID_JSON`).
- It has an invalid or unsupported schema (`UNSUPPORTED_SCHEMA`).
- Its declared `bundleId` does not match the recomputed `bundleId` (`INVALID_BUNDLE_ID`).
- Its declared `provenanceRoot` does not match the recomputed root (`INVALID_PROVENANCE_ROOT`).
- Any cryptographic integrity check fails (`CONTRACT_INTEGRITY_FAILURE`, `EVENT_INTEGRITY_FAILURE`, `CHECKPOINT_INTEGRITY_FAILURE`, `ATTEMPT_INTEGRITY_FAILURE`, `AUTHORITY_INTEGRITY_FAILURE`, `VERIFICATION_INTEGRITY_FAILURE`).
- The offline replay verifier derives `valid === false` (`REPLAY_VERIFICATION_FAILURE`).
- It attempts an identity collision against an existing archived bundle (`IDENTITY_CONFLICT`).
- It contains prohibited credentials or violates security policy (`SECURITY_POLICY_FAILURE`).

Quarantined bundles are stored in an isolated quarantine directory (`archive/quarantine/<reasonCode>/<quarantineId>.json`) and NEVER exposed as verified evidence.

---

### 7. Can a Malformed Bundle Reach the Replay Verifier?
**NO.** The ingestion gateway implements strict fail-closed pipeline ordering:
$$\text{Raw Bytes} \xrightarrow{\text{Size Check}} \xrightarrow{\text{JSON Parse}} \xrightarrow{\text{Schema Validation}} \xrightarrow{\text{BundleId Check}} \xrightarrow{\text{Replay Verifier}}$$
If a bundle fails size, parsing, schema, or bundle ID checks, it is immediately quarantined with the corresponding failure reason code and never reaches the replay verifier.

---

### 8. How Should Duplicate Bundles Behave?
- If an incoming bundle is valid, and an archive record with the same `bundleId` already exists, and the incoming canonical serialized bytes match the archived canonical bytes byte-for-byte:
- Ingestion returns **`DUPLICATE`**.
- The existing archived artifact is retained unchanged.
- No duplicate physical file or redundant archive record is created.
- The operation is strictly idempotent.

---

### 9. What Should Happen If the Same BundleId Has Different Bytes?
- If an incoming bundle declares `bundleId === X`, and an archive record for `X` already exists, but the incoming canonical bytes differ from the archived bytes:
- This is an **`IDENTITY_CONFLICT`**.
- The incoming bundle is immediately **`QUARANTINED`** with reason code `IDENTITY_CONFLICT`.
- The existing archived bundle is strictly preserved and NEVER overwritten.

---

### 10. What Information Must Be Retained for an Audit Trail?
For every ingestion attempt, the gateway records an immutable `IngestionRecord`:
- `bundleId`: Declared or recomputed bundle identifier.
- `status`: `ACCEPTED`, `DUPLICATE`, or `QUARANTINED`.
- `reasonCodes`: Array of specific deterministic failure codes (empty on `ACCEPTED` and `DUPLICATE`).
- `ingestedAt`: ISO-8601 timestamp of receipt.
- `sizeBytes`: Byte length of incoming raw payload.
- `replayValid`: Boolean indicating replay verification outcome.
- `archivePath`: Relative or absolute path to the archived artifact (`archive/accepted/<bundleId>.json`) if accepted.
- `quarantinePath`: Path to the quarantined artifact (`archive/quarantine/<reasonCode>/<quarantineId>.json`) if quarantined.
