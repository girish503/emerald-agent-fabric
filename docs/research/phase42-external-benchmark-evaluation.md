# Phase 42 — Clean-Room Benchmark Framework & Dual-Gate Oracle Calibration Pilot

## 1. Benchmark Mission & Research Question
The primary mission of Phase 42 is to establish a clean-room benchmark execution framework and dual-gate oracle calibration pilot using SWE-bench Verified-compatible tasks under strict zero-cost, local CPU-only, open-weight constraints.

The central research question is:
> **Can Emerald independently calibrate and decouple dual-gate verification oracles (FAIL_TO_PASS and PASS_TO_PASS), enforce multi-authority threshold Ed25519 signing on evidence bundles, and detect post-signing tampering and equivocation using a standalone offline auditor?**

Rather than making unverified claims about autonomous model problem-solving, Phase 42 decouples and independently measures:
- **Task fixture calibration**: Does each synthetic task define an isolated `FAIL_TO_PASS` defect and a distinct `PASS_TO_PASS` regression check?
- **Oracle sensitivity and specificity**: Does the clean-room test runner reliably fail on baseline defects and pass on verified gold patches?
- **Evidence integrity**: Are actions, events, and diffs immutably captured, canonically serialized, and SHA-256 hashed?
- **Authority provenance**: Can evidence bundles be signed and verified under 2-of-3 threshold Ed25519 signing?
- **Offline auditor verification**: Can an independent, zero-runtime CLI detect fourfold completion failures, post-signing payload tampering, and contradictory terminal records?

Autonomous model repair attempts, per-task token throughput, and live model pass rates are explicitly deferred to Phase 43+.

---

## 2. Upstream Benchmark Dataset Availability Audit & Outcome Classification
In accordance with Step 0 protocol requirements, a pre-run audit of the host environment was performed:
- **Upstream SWE-bench Verified Repository**: Not pre-installed locally.
- **Docker Environment Images (~100GB)**: Not present on host workstation.
- **External Network Policy**: Zero-network / zero-cloud hard constraint strictly prevents cloning remote git repositories or pulling external container layers.

### Outcome Classification
- **Classification**: `OUTCOME_B_SWE_BENCH_VERIFIED_COMPATIBLE_PILOT`
- **Specification**: A curated cohort of 12 SWE-bench Verified-compatible tasks modeled directly after official SWE-bench evaluation schemas (specifying problem statements, target files, `FAIL_TO_PASS` test suites, and `PASS_TO_PASS` test suites) was constructed locally and calibrated under clean-room conditions.

---

## 3. Benchmark Task Selection Methodology & Inclusion Criteria
Tasks were selected according to strict inclusion criteria:
1. **CPU Tractability**: Execution of each task test suite completes in `< 5` seconds on standard developer hardware without GPU acceleration.
2. **Deterministic Evaluation**: Tests rely on standard Node.js `node:assert` without network or timing dependencies.
3. **Dual-Gate Decoupling**: Each task defines an isolated `FAIL_TO_PASS` (F2P) test isolating the defect and a distinct `PASS_TO_PASS` (P2P) test verifying regression immunity.
4. **Domain Diversity**: Coverage across software engineering categories: bug fixing, edge cases, input validation, semver parsing, networking/representation, security/prototype pollution, refactoring, test repair, failure recovery, multi-file authorization, and configuration fallback.
5. **Cold-Start Reproducibility**: Each task can be instantiated into an ephemeral clean-room workspace from scratch.

---

## 4. Task Cohort Specification
The frozen benchmark cohort consists of 12 curated tasks (`scratch/phase42-task-selection.json`):

| Task ID | Domain / Category | Difficulty | Description | Oracle Gate Criteria |
| :--- | :--- | :--- | :--- | :--- |
| `EAF-BM-01` | Code Navigation | Easy | Off-by-one arithmetic defect in `add(a, b)` (`src/calc.js`) | F2P: `add(2, 3) === 5` & `add(-1, 1) === 0`; P2P: `multiply(4, 5) === 20` |
| `EAF-BM-02` | Localized Bug Fix | Easy | Hex shorthand expansion `#fff` to `[255, 255, 255]` (`src/hex.js`) | F2P: `parseHex("#fff")` & `parseHex("#000")`; P2P: `parseHex("#ff0000")` |
| `EAF-BM-03` | Input Validation | Medium | Prevent CRLF header injection in CORS `validateOrigin` (`src/cors.js`) | F2P: `validateOrigin` throws on `\r\n`; P2P: `validateOrigin('https://valid.example.com') === true` |
| `EAF-BM-04` | Boundary Conditions | Medium | Semver prerelease tag with hyphen support (`src/semver.js`) | F2P: `parsePrerelease("1.0.0-alpha-1") === "alpha-1"`; P2P: `parseMajor("1.2.3") === 1` |
| `EAF-BM-05` | Boundary Conditions | Medium | Compressed `::1` IPv6 representation validation (`src/ipv6.js`) | F2P: `isIPv6("::1") === true`; P2P: `isIPv6("2001:0db8:...") === true` |
| `EAF-BM-06` | Regression Fix | Medium | KvStore deleted key immediate lookup returns undefined (`src/kv-store.js`) | F2P: `s.delete("k1")` followed by `s.get("k1") === undefined`; P2P: `s.get("k2") === "v2"` |
| `EAF-BM-07` | Security Defect | Hard | Prevent prototype pollution via `__proto__` in `deepSet` (`src/deep-set.js`) | F2P: `deepSet({}, "__proto__.polluted", true)` leaves `Object.prototype.polluted === undefined`; P2P: `deepSet({}, "a.b", 42)` |
| `EAF-BM-08` | Small Refactor | Easy | Pure JSON formatter extraction `formatJsonEntry` (`src/logger.js`) | F2P: `formatJsonEntry("INFO", "hello")` pure export; P2P: `Logger.info` |
| `EAF-BM-09` | Test Repair | Medium | Repair discrete argument spreading in `emit(e, ...args)` (`src/emitter.js`) | F2P: `em.emit("data", 2, 3)` invokes listener with `(2, 3)`; P2P: `em.emit("ping")` |
| `EAF-BM-10` | Failure Recovery | Medium | Tolerant filesystem scanner ignoring `EACCES` errors (`src/scanner.js`) | F2P: `scan("restricted")` returns `{ warnings: ["EACCES: permission denied"] }`; P2P: `scan("normal")` returns files |
| `EAF-BM-11` | Multi-File Feature | Hard | Model role check `User.hasRole` wired into `canAccess` (`src/user.js`) | F2P: `canAccess(adminUser, "admin") === true`; P2P: `User.id === "1"` |
| `EAF-BM-12` | Config Recovery | Easy | Fallback to default `{ env: "production", port: 8080 }` on missing config (`src/config.js`) | F2P: `loadConfig(null).env === "production"`; P2P: `validateConfig({ env: "test" }) === true` |

---

## 5. Execution Protocol & Environment Isolation
All benchmark tasks are governed under frozen protocol `scratch/phase42-protocol.json`:
- **Isolation**: Ephemeral workspaces created in isolated OS temp directories, decoupled from host source tree.
- **Resource Limits**:
  - `maxSteps`: 10
  - `stepTimeoutMs`: 120,000 ms
  - `toolTimeoutMs`: 30,000 ms
  - `actionLimit`: 15
  - `outputLimitBytes`: 65,536 bytes
- **Test Integrity**: Test directories (`test/f2p.test.js` and `test/p2p.test.js`) are read-only and immutable to the agent; workspace path policy rejects any write attempts targeting test files.

---

## 6. Model & Inference Specification (Target Configuration)
- **Model Target**: `qwen2.5-coder:1.5b` (open-weight, locally hosted).
- **Quantization**: `Q4_K_M`.
- **Execution Mode**: CPU-only via local Ollama inference runner.
- **Context Window**: 4,096 tokens (as specified in `scratch/phase42-protocol.json`).
- **Stochasticity**: Deterministic seed is null (`stochasticityNote: "STOCHASTICITY_NOT_CONTROLLED"`).
- **Zero Proprietary API Guarantee**: No requests routed to OpenAI, Anthropic, or Google APIs.
- **Execution Status**: *Model inference was not executed in Phase 42. Specifications reflect the frozen protocol target for Phase 43+ benchmark execution.*

---

## 7. Dual-Gate Verification Mechanism
Emerald separates verification into two distinct, non-negotiable gates:
1. **Gate 1: `FAIL_TO_PASS` (F2P)**: Validates that the reported defect or missing capability is specifically fixed. On the unmodified baseline, F2P **must fail**.
2. **Gate 2: `PASS_TO_PASS` (P2P)**: Validates that pre-existing functionality remains unbroken. On the unmodified baseline, P2P **must pass**.
3. **Clean-Room Verifier**: Executed in a fresh, out-of-process clean-room workspace with unmodified tests, ensuring agent runtime pollution cannot mask test failures.

---

## 8. Gold Patch Verification Baseline & Oracle Calibration
Before evaluating agent proposals, the dual-gate oracles were calibrated against human-authored gold patches:
- **Baseline Precondition Verification**:
  - All 12/12 baseline tasks failed their respective F2P tests with expected failure codes (`exitCode !== 0`).
  - All 12/12 baseline tasks passed their respective P2P regression suites (`exitCode === 0`).
- **Gold Patch Calibration**:
  - Applying gold patches to all 12 tasks resulted in 12/12 passing both F2P and P2P gates under clean-room verification.
  - Cohort Oracle Calibration: **100.0% (12/12)** across the selected cohort fixtures.
  - *Scope & Limitation*: This sensitivity and specificity rate applies strictly to the 12 selected synthetic cohort fixtures and their human-authored gold patches. It is a calibration verification of these specific decoupled test suites, not a general estimate of autonomous repair accuracy or real-world benchmark performance.

---

## 9. Negative Control Design & Calibration Scope
To test verification defenses, 7 negative calibration controls were evaluated:
- **FP1 (Baseline Defect Oracle Sensitivity)**: Unmodified defective code fails F2P test; verified via oracle exit code.
  - *Scope & Limitation*: Demonstrates oracle defect sensitivity; does not exercise an actual runtime controller receiving an autonomous premature `isGoalReached: true` signal.
- **FP2 (Wrong Patch Rejection)**: Syntactically valid code that produces incorrect semantic output fails F2P assertion check.
  - *Scope*: Exercised via out-of-process child Node test execution.
- **FP3 (Regression-Inducing Patch Rejection)**: Fixes F2P defect but breaks existing P2P functionality; rejected by P2P gate.
  - *Scope*: Exercised via out-of-process child Node test execution.
- **FP4 (Zero-Mutation Assertion Check)**: Checks `patchBytes === 0` indicates no code mutation.
  - *Scope & Limitation*: Static assertion check; does not test workspace path fencing or active runtime rejection at the gateway.
- **FP5 (Falsified Completion Bundle Rejection)**: Synthetic evidence bundle claiming `COMPLETED` with an underlying failed tool attempt (`exitCode: 1`) rejected by `OfflineAuditor` via fourfold check, despite holding valid 2-of-3 threshold Ed25519 signatures.
  - *Scope*: Exercised against `OfflineAuditor.verifyEvidence`.
- **FP6 (Contradictory Terminal Record Injection)**: Injecting competing terminal bundles for the same `runId` detected and rejected by `OfflineAuditor` with `TERMINAL_CONFLICT`.
  - *Scope*: Exercised against `OfflineAuditor.verifyEvidence(archiveDir)`.
- **FP7 (Post-Run Evidence Tampering)**: Modifying `bundleId` of a valid signed bundle detected and rejected by `OfflineAuditor` with `BUNDLE_ID_MISMATCH`.
  - *Scope*: Exercised against `OfflineAuditor.verifyEvidence(filePath)`.

---

## 10. Autonomous Agent Live Execution Status
- **Status**: **DEFERRED TO PHASE 43+**.
- **Scope Clarification**: Phase 42 is an oracle calibration and verification hardening milestone. No live Ollama model attempts were executed or recorded. Claims of 12 live model attempts, 0% solve rate, and failure breakdowns from earlier drafts were speculative narrative placeholders and are formally withdrawn.
- **Planned Work**: Live model execution against the calibrated 12-task cohort will be conducted in Phase 43 with complete telemetry, prompt traces, and recorded evidence archives.

---

## 11. Clean-Room Verification Results & Oracle Behavior
Clean-room verification functioned with zero false acceptances across calibration:
- Total verification runs: 24 (12 baseline precondition checks + 12 gold patch calibration runs).
- Zero instances of sandbox escape or state leakage between runs.
- 100% adherence to dual-gate verification requirements across the 12 fixtures.

---

## 12. Fourfold Completion Audit Calibration
Under the Emerald Fourfold Completion model:
1. `terminalState === COMPLETED`
2. `isGoalReached === true`
3. Clean-room verification passed (`exitCode === 0`)
4. Zero unresolved or unhandled tool failures

Result: In FP5, an artificially constructed bundle attempting to claim `COMPLETED` with an underlying failed attempt was rejected by `OfflineAuditor` with `FOURFOLD_COMPLETION_FAILURE`, confirming that valid cryptographic signatures cannot bypass completion rules.

---

## 13. Evidence Bundling & Content-Addressed Identity Integrity
- Evaluated on synthetic golden runs via `RunCoordinator`, `SqliteStateStore`, and `EvidenceExporter`.
- Canonical bundle serialization uses deterministic JSON key sorting and SHA-256 hashing.
- `bundleId` accurately identified content snapshots; byte-for-byte integrity verified on generated bundles.

---

## 14. Multi-Authority Threshold Signing Evaluation (2-of-3 Ed25519)
- Keyring initialized with three independent authorities:
  - `auth-worker-1` (`WORKER_PRODUCER`)
  - `auth-supervisor-1` (`SUPERVISOR`)
  - `auth-verifier-1` (`INDEPENDENT_VERIFIER`)
- Threshold quorum: 2-of-3.
- All valid terminal bundles received Ed25519 signatures from Worker and Supervisor.
- Bundles lacking 2 distinct valid signatures were rejected by `OfflineAuditor`.

---

## 15. Authoritative Terminal Record Index & Equivocation Fencing
- Evaluated in Test 1.9 (FP6) via `OfflineAuditor.verifyEvidence(archiveDir)`.
- When an archive directory contained two distinct terminal bundles for the same `runId` with only one referenced by `terminal.json`, the auditor rejected the archive with `TERMINAL_CONFLICT`.
- Invariant preserved: **A run may have multiple immutable snapshots, but at most one authoritative terminal record.**

---

## 16. Standalone Offline Auditor Independent Verification Results
The Phase 41 `OfflineAuditor` was executed against synthetic reference bundles:
- **Reference Bundles Audited**: 2 (1 valid `COMPLETED` -> `VERIFIED`, 1 fourfold-failed -> `FAILED`).
- **Audit Parity Rate**: 2/2 (100.0%).
- **Verification Integrity**: Offline auditor independently verified bundle SHA-256 IDs, Ed25519 threshold signatures, event sequence monotonicity, fourfold completion criteria, and absence of unredacted secrets without requiring database access or runtime coupling.

---

## 17. Governance & Failure Classification Taxonomy
The structured error taxonomy from `GEMINI.md` Section 26 (`TASK_FAILURE`, `MODEL_FAILURE`, `TOOL_FAILURE`, `ENVIRONMENT_FAILURE`, `POLICY_FAILURE`, `VERIFICATION_FAILURE`) was validated at the schema level. Empirical failure classification distributions will be recorded during live model benchmarking in Phase 43.

---

## 18. Calibration Controls Summary & Limitation Matrix

| Control | Description | Mechanism Exercised | Result | Scope & Known Limitations |
| :--- | :--- | :--- | :--- | :--- |
| **FP1** | Premature `isGoalReached` | Baseline Defect Oracle Check | **PASS** | Checks baseline defect fails F2P; does not exercise active runtime controller rejection. |
| **FP2** | Semantically incorrect patch | F2P Assertion Check | **PASS** | Child process test execution rejects wrong patch output. |
| **FP3** | Regression-inducing patch | P2P Assertion Check | **PASS** | Dual-gate decoupling rejects patch that breaks existing tests. |
| **FP4** | Zero-mutation patch | `patchBytes === 0` Assertion | **PASS** | Static assertion check; does not test workspace path fencing or gateway rejection. |
| **FP5** | Falsified completion bundle | Fourfold Completion Auditor | **PASS** | `OfflineAuditor` rejects 2-of-3 signed bundle containing failed attempt. |
| **FP6** | Contradictory terminal state | Authoritative Terminal Index | **PASS** | `OfflineAuditor` flags `TERMINAL_CONFLICT` on conflicting terminal bundles in archive. |
| **FP7** | Tampered bundle payload | Content Hash Verifier | **PASS** | `OfflineAuditor` flags `BUNDLE_ID_MISMATCH` on post-signing byte mutation. |

*Rejection-rate note*: An unqualified "7/7 end-to-end rejection rate" is not claimed. FP1 and FP4 are unit/oracle calibration assertions. FP2, FP3, FP5, FP6, and FP7 operate as verified within their defined test boundaries.

---

## 19. Auditor Agreement Scope
- Auditor Parity: **100.0% (2/2)**.
- Parity was confirmed on 2 reference bundles (one valid, one fourfold-failed).
- Cohort-scale bundle audit agreement will be evaluated once live model run bundles are generated in Phase 43.

---

## 20. Terminal Authority Integrity & Anti-Equivocation Analysis
- Tested Anti-Equivocation Parity: Confirmed across the specific archive conflict scenarios exercised by Test 1.9 (FP6), where competing terminal records or unindexed terminal bundles for the same `runId` were detected and rejected with `TERMINAL_CONFLICT`.
- *Scope & Limitation*: This verification confirms anti-equivocation behavior within the tested archive structure and index rules; it does not constitute a universal integrity guarantee across unconstrained Byzantine failure modes or all theoretical archive attack surfaces.

---

## 21. Computational Resource Profiling & Test Execution
Observed execution measurements from the Phase 42 test suite:
- **Aggregate Test Suite Duration**: ~7.2–8.0 seconds total test execution (11.3s process lifecycle) across all 11 tests in `tests/integration/phase42-external-benchmark.test.ts` as recorded by Vitest.
- **Fixture Execution Timing**: Individual per-fixture execution time was not measured with dedicated high-resolution timers (the test harness provider returned static mock durations). Measured data is restricted to aggregate test suite execution.
- **Zero Proprietary API / Cloud Costs**: $0.00 spent.
- **CPU-First Execution**: Ran entirely on local CPU without GPU hardware requirements.
- **Unmeasured Metrics**: Local model inference latency, token generation throughput, and active runtime RAM consumption are unmeasured pending live execution in Phase 43.

---

## 22. CPU-First Workstation Performance & Sustainability
- All 12 task fixtures execute natively under standard Node.js without requiring Docker daemon startup or container downloads.
- Workstation memory footprint during fixture testing remains well within standard developer laptop limits.

---

## 23. Comparison Between Claimed Repairs and Governed Calibration
| Dimension | Ungoverned Benchmark Evaluation | Emerald Governed Calibration Framework |
| :--- | :--- | :--- |
| **Defect Isolation** | Single monolithic test run | Decoupled F2P and P2P dual-gate assertions |
| **Patch Validation** | Assumed from exit code | Clean-room isolated re-execution |
| **Evidence** | Transient console stdout | Cryptographically signed immutable bundle |
| **Authority** | Single process / model output | 2-of-3 Ed25519 Quorum |
| **Equivocation** | Permitted (competing runs overwrite) | Fenced by Authoritative Terminal Record Index |

---

## 24. Architectural Invariants Preserved
- Invariant 1: Local-only, zero-cost, open-source execution.
- Invariant 2: Step controller limits and lease fencing configured.
- Invariant 3: Dual-gate clean-room verification (F2P + P2P) decoupled from agent workspace.
- Invariant 4: Fourfold completion model strictly enforced by auditor.
- Invariant 5: 2-of-3 threshold signature scheme required for bundle verification.
- Invariant 6: Single authoritative terminal record per `runId`.
- Invariant 7: Standalone offline verification without runtime coupling.

---

## 25. Security & Sandboxing Implications Observed
- Dual-gate tests execute in isolated OS temporary directories.
- Offline auditor inspects evidence bundles strictly read-only, avoiding environment pollution or state contamination.

---

## 26. Threats to Validity & Experimental Limitations
1. **Calibration Scope**: Phase 42 calibrates test fixtures, dual-gate oracles, and evidence auditing; it does not evaluate autonomous model reasoning.
2. **Negative Control Depth**: FP1 and FP4 are unit/oracle assertions rather than end-to-end runtime rejection paths.
3. **Auditor Agreement Cohort**: Parity was verified on 2 synthetic reference bundles; full 12-task archive verification awaits live execution.
4. **Synthetic Cohort Scope**: The 12-task cohort is modeled on SWE-bench Verified schemas but uses Node.js/JavaScript runtimes native to the developer workstation.

---

## 27. Lessons Learned for Autonomous Software Engineering Benchmarks
1. **Calibration Before Execution**: Before deploying an autonomous agent on benchmark tasks, dual-gate oracle sensitivity and specificity must be calibrated against human gold patches.
2. **Distinguish Framework from Findings**: A benchmark evaluation framework must not claim model task performance until live model attempts are executed, recorded, and audited.
3. **Evidence Integrity is Independent of Model Pass Rate**: An agent fabric can establish robust evidence verification and anti-equivocation even prior to running live model attempts.

---

## 28. Next Steps: Phase 43 Live Benchmark Execution
1. Implement a dedicated local Ollama benchmark runner (`scripts/run-phase43-benchmark.ts`).
2. Execute `qwen2.5-coder:1.5b` across the calibrated 12-task cohort with recorded prompts, tool calls, and per-step latencies.
3. Ingest all 12 resulting run bundles into an authoritative archive and execute `OfflineAuditor` across the full live cohort.

---

## 29. Complete Conclusion & Final Decision Block

```text
================================================================================
PHASE 42 FINAL DECISION BLOCK
================================================================================
STATUS: COMPLETE (CALIBRATION FRAMEWORK MILESTONE)
BENCHMARK_COMPATIBILITY: SWE-BENCH-VERIFIED-COMPATIBLE-PILOT (CALIBRATION ONLY)
COHORT_TASKS_CALIBRATED: 12 (12/12 Synthetic Node.js Fixtures Verified)
BASELINE_ORACLE_CALIBRATION: 100.0% (12/12 Baseline Preconditions Failed F2P, Passed P2P)
GOLD_PATCH_CALIBRATION: 100.0% (12/12 Gold Patches Passed Both F2P & P2P)
COHORT_ORACLE_CALIBRATION: 100.0% (12/12 Synthetic Fixtures Calibrated; Not General SWE Performance)
CALIBRATION_CONTROLS_STATUS:
  - FP1 (Baseline defect oracle sensitivity): VERIFIED (Limited scope; not end-to-end runtime)
  - FP2 (Semantic wrong patch): REJECTED AT ORACLE (Child process execution)
  - FP3 (Regression patch): REJECTED AT ORACLE (Dual-gate decoupling)
  - FP4 (Zero-mutation assertion): VERIFIED (Static assertion; not gateway fencing)
  - FP5 (Falsified completion bundle): REJECTED BY OFFLINE AUDITOR (Fourfold check)
  - FP6 (Contradictory terminal outcome): REJECTED BY OFFLINE AUDITOR (TERMINAL_CONFLICT)
  - FP7 (Post-run byte tampering): REJECTED BY OFFLINE AUDITOR (BUNDLE_ID_MISMATCH)
OFFLINE_AUDITOR_AGREEMENT: 100.0% (2/2 Reference Bundles Verified)
TESTED_ANTI_EQUIVOCATION_PARITY: 100.0% (Archive Conflict Rejection Verified; Tested Scope Only)
AGENT_LIVE_BENCHMARK_STATUS: DEFERRED_TO_PHASE_43 (No live inference conducted)
INFERENCE_LATENCY_AND_RAM: UNMEASURED (Awaiting Phase 43 runner instrumentation)
HISTORICAL_INVARIANTS: Preserved
ZERO_COST_LOCAL_CPU_INVARIANT: Preserved ($0.00 Spent)
================================================================================
```
