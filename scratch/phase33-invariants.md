# Phase 33B — Provenance Model & Replay Invariants
## Formal Specification of Evidence Bundle and Replay Invariants

---

### P1 — Bundle Identity
Every evidence bundle has a deterministic, tamper-evident bundle identifier computed strictly over the canonical representation of the bundle content excluding the `bundleId` property itself:
$$\text{bundleId} = \text{SHA256}(\text{canonicalJsonStringify}(\text{bundle without bundleId}))$$
Any mutation to any field inside the bundle invalidates the `bundleId`.

---

### P2 — Canonical Serialization
All structures used in hash computation and bundle serialization MUST follow deterministic canonical serialization rules:
1. Object keys sorted lexicographically at every level.
2. Arrays maintain stable, deterministic ordering (elements sorted when semantically unordered, e.g., set of identifiers).
3. Stable UTF-8 encoding.
4. Explicit `null` preservation; `undefined`, functions, and symbols omitted.
5. Zero runtime timestamps or random UUIDs generated during verification.
6. Pure, platform-independent output identical across Node.js runtimes.

---

### P3 — Contract Binding
The bundle must contain the exact `MissionContractSpec`, bound `contentHash`, `contractId`, and `version`.
The verifier must independently recompute:
$$\text{computedHash} = \text{SHA256}(\text{canonicalJsonStringify}(\text{bundle.contract.spec}))$$
and assert $\text{computedHash} = \text{bundle.contract.contentHash} = \text{bundle.run.contractBinding.contentHash}$.

---

### P4 — Event Sequence
The bundled event stream must contain a contiguous, gapless sequence of events:
$$\text{sequence} \in \{1, 2, 3, \dots, M\}$$
No sequence gaps, no duplicate sequences, and no out-of-order events are permitted.

---

### P5 — Event Hash Integrity
Each event in the bundle must possess a deterministic cryptographic hash computed over its sequence, event ID, event type, timestamp, producer, canonical payload, and the preceding event's hash:
$$H_i = \text{SHA256}(\text{canonicalJsonStringify}(\{ \text{sequence}, \text{eventId}, \text{eventType}, \text{timestamp}, \text{producer}, \text{payload}, \text{previousEventHash} \}))$$

---

### P6 — Previous-Event Binding (Hash Chain)
Events form an unbroken cryptographic hash chain:
$$e_i.\text{previousEventHash} = \begin{cases} \text{SHA256}(\text{"genesis:"} + \text{runId}) & \text{for } i = 1 \\ e_{i-1}.\text{eventHash} & \text{for } i > 1 \end{cases}$$
Deleting, inserting, swapping, or mutating any event invalidates the hash chain at and after that position.

---

### P7 — Attempt Identity
Every attempt record in the bundle must preserve:
$$\{ \text{attemptId}, \text{actionId}, \text{runId}, \text{attemptNumber}, \text{workerId}, \text{leaseId}, \text{status}, \text{idempotencyToken} \}$$
The verifier asserts that each attempt references an existing `actionId` and `runId` and matches its recorded `idempotencyToken`.

---

### P8 — Attempt Monotonicity
For every action with $K$ attempts, the attempts must be numbered strictly:
$$\text{attemptNumber} \in \{1, 2, \dots, K\}$$
with no gaps, no duplicates, and in non-decreasing temporal order.

---

### P9 — Historical Immutability
Prior attempts ($1..K-1$) must reflect their authentic historical states (`FAILED`, `UNKNOWN`, `TIMED_OUT`, `CANCELLED`). An in-flight or recovered attempt from a prior worker crash must remain frozen in `UNKNOWN` or `FAILED`; it cannot be rewritten or erased by subsequent attempts.

---

### P10 — Checkpoint Continuity
Checkpoints in the bundle must be ordered by strictly monotonic `checkpointVersion` ($1, 2, \dots, C$). Each checkpoint must reference a committed `eventSequence` $\le M$ and valid `actionId`/`attemptNumber` existing at or before that sequence point. A checkpoint cannot reference future events.

---

### P11 — Authority Provenance
Every authoritative state transition (claim, start, execution, recovery) must preserve identity establishing the governing worker or supervisor:
- An attempt must be owned by the worker holding the active worker lease at the time of attempt creation.
- A recovery event must be produced by the supervisor holding the active supervisor lease for the run.
- Attempted mutations under an expired or mismatched lease fail authority verification.

---

### P12 — Contract Continuity Across Recovery
When a mission recovers from Attempt $N$ to Attempt $N+1$, the contract binding (`contractId`, `version`, `contentHash`) must remain identical. Replay must verify that no attempt switches governance contracts silently.

---

### P13 — Verification Evidence Binding
Every verification evidence entity must be cryptographically associated with:
- `runId`
- `specId`
- `contentHash`
- `evidenceIds` referenced by the attempt or verification event
Detached, orphaned, or unreferenced verification evidence cannot be used to establish mission completion.

---

### P14 — Fourfold Outcome Derivation
Replay does NOT trust a boolean `success = true` or `status = "COMPLETED"`. The replay engine independently derives the fourfold completion components:
1. **`TaskSatisfied`**: Terminal completion was requested (`isGoalReached: true` / terminal reason `GOAL_REACHED` or valid terminal action).
2. **`VerificationPassed`**: All contract-declared verification specs (`EXIT_CODE_ZERO`, `EXACT_OUTPUT_MATCH`, `OUTPUT_HASH_MATCH`, `CLEAN_ROOM_DUAL_GATE`) independently evaluate to `VERIFIED` against recorded evidence.
3. **`PolicySatisfied`**: Actions executed complied with contract resource limits and allowed tools.
4. **`EvidenceComplete`**: All required evidence IDs are present and intact with valid hashes.

---

### P15 — Terminal Outcome Derivation
The mission's terminal outcome is derived logically from replayed state:
- If all fourfold criteria pass $\implies$ `terminalOutcome = "COMPLETED"`.
- If retries were exhausted, budget exhausted, verification failed, or recovery halted $\implies$ `terminalOutcome = "FAILED"`.
Any discrepancy between derived outcome and producer-declared outcome constitutes a verification failure.

---

### P16 — Clean-Room Offline Verification
The replay engine MUST execute in complete isolation:
- No network connections.
- No SQLite database access.
- No filesystem access to original run artifacts.
- No Docker containerization.
- No Ollama or LLM model inference.
- No tool execution or code evaluation.
The verifier evaluates purely from the bundled data and deterministic state-transition rules.
