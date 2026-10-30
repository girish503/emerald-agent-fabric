# Phase 34B — Ingestion & Archival Invariants
## Formal Invariants for Cross-Host Evidence Ingestion and Content-Addressed Archival

---

### I1 — Untrusted Input
Every incoming bundle entering the ingestion boundary is treated as untrusted data until independently validated. The ingestion layer places zero trust in producer identities, declarations, or execution claims.

---

### I2 — Size Bound
Incoming bundle raw payloads must not exceed the deterministic ceiling of $10\text{ MB}$ ($10,485,760\text{ bytes}$). Payloads exceeding this limit are rejected immediately before JSON parsing with failure code `BUNDLE_TOO_LARGE`.

---

### I3 — Schema Bound
The incoming payload must parse into valid JSON conforming strictly to the `EvidenceBundle` schema:
- `formatVersion === "emerald-evidence-bundle-v1"`
- `schemaVersion === 1`
- All required fields (`run`, `contract`, `checkpoints`, `events`, `actions`, `attempts`, `supervisorEvidence`, `verificationEvidence`, `verificationResults`, `terminalState`, `provenance`, `bundleId`, `provenanceRoot`) must be present with valid types.
Non-conforming payloads fail closed with `UNSUPPORTED_SCHEMA` or `INVALID_JSON`.

---

### I4 — Bundle ID Recalculation
The ingestion gateway never trusts the declared `bundle.bundleId`. It independently recomputes:
$$\text{recomputedBundleId} = \text{computeBundleId}(\text{bundleContent without bundleId})$$
If $\text{declaredBundleId} \neq \text{recomputedBundleId}$, the bundle is quarantined with `INVALID_BUNDLE_ID`.

---

### I5 — Provenance Root Recalculation
The ingestion gateway never trusts the declared `bundle.provenanceRoot`. It independently recomputes the provenance root across the 5 subsystem roots (`contractHash`, `eventRoot`, `checkpointRoot`, `attemptRoot`, `verificationRoot`).
If $\text{declaredProvenanceRoot} \neq \text{recomputedProvenanceRoot}$, the bundle is quarantined with `INVALID_PROVENANCE_ROOT`.

---

### I6 — Replay Verification
An evidence bundle CANNOT be classified as `ACCEPTED` unless `EvidenceReplayVerifier.verify(bundle)` succeeds with `valid === true`. If replay fails, the bundle is quarantined with `REPLAY_VERIFICATION_FAILURE`.

---

### I7 — Duplicate Idempotency
Submitting the exact same valid bundle multiple times is strictly idempotent:
- First submission: `ACCEPTED` and archived.
- Subsequent submissions: `DUPLICATE`.
- No duplicate archive file or redundant archive record is created.

---

### I8 — Hash Collision / Identity Conflict
If an incoming bundle declares or computes a `bundleId` that already exists in the archive, but its canonical bytes differ from the archived bytes:
$$\text{canonicalBytes}(\text{incoming}) \neq \text{canonicalBytes}(\text{archived})$$
The incoming bundle is quarantined with `IDENTITY_CONFLICT`. The existing archived bundle is strictly immutable and protected from overwrite.

---

### I9 — Archive Immutability
Once an accepted bundle is written to the archive (`archive/accepted/<bundleId>.json`), it is permanently read-only and immutable. Ingestion never performs in-place updates or overwrites of existing accepted artifacts.

---

### I10 — Quarantine Isolation
Quarantined bundles are stored strictly in an isolated quarantine directory (`archive/quarantine/<reasonCode>/<quarantineId>.json`). Quarantined bundles are never indexed in the accepted registry, never returned by archive lookups, and never treated as verified evidence.

---

### I11 — Producer Independence
Archive acceptance and verification must not depend on the producer runtime remaining active. The producer process may terminate, crash, or be destroyed; the ingestion gateway and archive operate completely autonomously.

---

### I12 — Offline Verification
Any accepted bundle stored in the archive must remain independently verifiable at any future time using `verifyArchivedBundle(bundleId)` without requiring access to the producing host, SQLite database, Docker, or network.

---

### I13 — Deterministic Classification
Given identical input bytes, the ingestion gateway will always produce an identical `IngestionResult` (`status`, `recomputedBundleId`, `reasonCodes`) regardless of execution environment or timing.

---

### I14 — Zero Execution
Ingestion and verification must NEVER execute:
- Shell commands (`exec`, `spawn`, `fork`)
- Candidate patches or diffs
- Physical tools
- Dynamic JavaScript (`eval`, `Function`, dynamic imports)
- Model inference or Ollama APIs
All bundle data is treated strictly as passive structured text.

---

### I15 — Secret Safety & Path Sanitation
- The ingestion gateway preserves the Phase 33 secret redaction invariants.
- Filesystem archive paths are constructed strictly from deterministic hex digests derived by the verifier (`<bundleId>.json`), NEVER from untrusted user-controlled or producer-controlled string fields, preventing path traversal or arbitrary filename injection.
