# Milestone 2.4B Specification and Planning

**Status**: APPROVED — ARCHITECTURE ACCEPTED (Decision F-6.7)<br/>
**Document Version**: 1.1<br/>
**Date**: 2026-11-02<br/>
**Author**: Implementation Engineering System (Emerald Agent Fabric)<br/>
**Baseline Commit**: `8a8a9b210bae3601b25456c79941fc24471f1ec4`<br/>
**Related Architecture Records**:
- [ADR-0036: Durable Mutation Intent, Crash Recovery, and Workspace Ownership Contract](../adr/ADR-0036-durable-mutation-intent-crash-recovery-and-workspace-ownership-contract.md)
- [ADR-0037: Tenant Quiescence Before Recovery Mutates or Disposes a Workspace](../adr/ADR-0037-tenant-quiescence-before-workspace-mutation-by-recovery.md)
- [ADR-0038: Close Late-Start Tenant Race with Coordination Gate](../adr/ADR-0038-close-late-start-tenant-race-with-coordination-gate.md)
- [ADR-0039: CI Quality Baseline and POSIX Integrity Gate](../adr/ADR-0039-ci-quality-baseline-and-posix-integrity.md)
- [ADR-0040: Docker Create/Start Lifecycle Split for Late-Start Race Reduction](../adr/ADR-0040-docker-create-start-split.md)
- [ADR-0041: Recovery Safety Boundary Remediation: Direct Invocations, Durable Quarantine, and Fenced Re-Execution](../adr/ADR-0041-recovery-safety-boundary-remediation.md)
- [ADR-0042: Container Timeout Strategy and Workload Lifetime Containment](../adr/ADR-0042-container-timeout-strategy-and-lifetime-containment.md)

---

## 1. Purpose and Problem Statement

### 1.1 Purpose
The purpose of Milestone 2.4B is to establish an evidence-backed verification baseline and resolve deferred operational boundaries following the completion of Milestone 2.4A.

Milestone 2.4A systematically closed critical race and safety vulnerabilities:
1. Implemented the two-phase `docker create` and `docker start` split ([ADR-0040](../adr/ADR-0040-docker-create-start-split.md)) to prevent in-flight container spawn operations from executing untracked code after worker aborts or timeouts.
2. Established durable recovery authority and tenant launch gate fencing ([ADR-0041](../adr/ADR-0041-recovery-safety-boundary-remediation.md)), introducing the `QUARANTINED` launch gate status, anti-stealing under quarantine, and token-fenced gate release to prevent concurrent execution during crash recovery.

Milestone 2.4B builds upon these foundations by defining the formal verification requirements, investigating deferred container lifetime mechanisms (`[ADR-0037-D3]`), and defining operator visibility into quarantined execution gates.

### 1.2 Problem Statement
While 243 focused unit tests currently establish the mathematical correctness of the coordinator state machine, Docker provider mocks, and recovery boundaries, several operational questions remain open before containerized tenant execution can be advanced further:

1. **Unrehearsed Integration Boundary**: The changes introduced in ADR-0040 (`docker create` / `docker start` split) and ADR-0041 (durable `QUARANTINED` gate transitions) have been validated under unit test mocks, but have not yet been executed in an authorized, controlled live Docker integration rehearsal against a real Docker daemon.
2. **Deferred Container Lifetime Enforcers (`[ADR-0037-D3]`)**: In ADR-0039, decision `[ADR-0037-D3]` (container-side maximum lifetime timeout wrappers via image entrypoints) was deferred to Milestone 2. A formal evaluation is required to determine whether container-side entrypoint wrapping is necessary given the host-side timeout enforcement and inert-container properties established by ADR-0040.
3. **Operator Inspection of Quarantined Runs (`[ADR-0037-D5]`)**: ADR-0041 introduced durable `QUARANTINED` gates in SQLite. However, operators currently lack a dedicated read-only CLI or diagnostic tool to inspect quarantined runs, view gate lease and holder status, and determine why recovery held a run.

---

## 2. Scope Discovery & Candidate Capabilities

### 2.1 Scope Candidate Investigation

| Candidate Capability | Existing Evidence | Current Implementation Status | Dependencies | Classification & Decision |
|---|---|---|---|---|
| **1. Controlled Live Docker Integration Rehearsal** | `tests/integration/docker-cancellation.integration.test.ts` (titled Milestone 2.4A); updated for ADR-0040 in commit `70c3a4d`. | Suite exists with 9 scenario groups (with nested subcases); opt-in via `EMERALD_DOCKER_INTEGRATION=1`. Skipped by default. | Running Docker daemon; pre-existing `node:22-alpine` image; explicit human authorization. | **Documented requirement / Core Milestone Scope**: Execute controlled live rehearsal to empirically validate ADR-0040 and ADR-0041 under real daemon conditions. |
| **2. Container Timeout Strategy (`[ADR-0037-D3]`)** | ADR-0037 §7 Decision D3; ADR-0039 §1 Decision `[ADR-0037-D3]`; ADR-0042. | ADR-0042 Alternative C approved by project owner in F-6.7 (layered host-primary, recovery-fenced model; mandatory container entrypoint wrapper rejected). | `DockerExecutionProvider`, container image contract. | **Documented requirement / Architectural Decision**: Resolved via ADR-0042 (ACCEPTED). |
| **3. Read-Only Quarantine Diagnostic Inspection** | ADR-0041 §4.1 conceptually proposed quarantine tracking; ADR-0039 `[ADR-0037-D5]` deferred force-release. Note: SQLite schema contains `run_id`, `holder_type`, `holder_id`, `lease_id`, `token`, `acquired_at`, `expires_at`, `released_at`, `state`, `owner_pid`, but no `reason` column. | Database schema stores quarantine status; no dedicated CLI query command exists. | `SqliteTenantLaunchCoordinator`, CLI launcher. | **Potential scope**: Introduce read-only inspection command (`emerald recovery status`) displaying existing schema fields without destructive bypass. |
| **4. Live Multi-Worker Recovery Daemon Orchestrator** | ADR-0002 §3 (states distributed multi-worker requires Raft/Postgres); ADR-0041 (local SQLite WAL invariants only). | Single-process CLI recovery exists (`node bin/emerald.js recovery sweep`). Multi-worker daemon not scheduled. | Background process supervision, OS service managers. | **Out of scope**: Distributed multi-worker orchestration is explicitly excluded by ADR-0002 and ADR-0041. |
| **5. Model Execution Wiring into Docker Sandboxes** | ADR-0010, ADR-0012, ADR-0039 `[PHASE0-D3]` (Docker execution remains test adapter outside production CLI). | Local model providers exist (`OllamaModelProvider`, `MockModelProvider`); Docker provider is isolated. | Ollama daemon, host memory bounds (<8 GB RAM). | **Out of scope**: Milestone 2.4 is strictly an execution sandboxing and recovery safety boundary milestone; model execution belongs to agent loop evaluation phases. |

### 2.2 Scope Boundaries

#### Confirmed In-Scope Candidates
1. **Live Docker Rehearsal Execution & Evidence Capture**: Execute `tests/integration/docker-cancellation.integration.test.ts` against a live Docker daemon under strict isolation (no image pulling, `--network=none`, isolated temporary directory mounts, bounded 90-second timeout).
2. **Resolution of ADR-0037-D3 (Container Timeout Strategy)**: Formally resolved via ADR-0042 (ACCEPTED), adopting Alternative C (Layered Defense-in-Depth) and rejecting mandatory container-side entrypoint wrappers.
3. **Quarantine Diagnostic Visibility (Read-Only)**: Provide read-only diagnostic reporting of `tenant_launch_gates` rows in `QUARANTINED` status based on existing database fields (`run_id`, `holder_type`, `holder_id`, `state`, `acquired_at`, `expires_at`, `released_at`, `owner_pid`) to give operators complete visibility into fail-closed holds without altering the database schema.

#### Explicit Non-Goals / Out of Scope
1. **No Production CLI Promotion of Docker Provider**: Uphold `[PHASE0-D3]` and `[ADR-0037-D1]`. `DockerExecutionProvider` remains an isolated research and test adapter. Production agent workflows continue to use `InProcessExecutionProvider` (`tenantModel = "NONE"`).
2. **No Distributed Multi-Node Orchestration**: Emerald relies on local-first SQLite in WAL mode. Distributed consensus (Raft/Paxos) is explicitly out of scope.
3. **No Unfenced Force-Release Tooling**: Uphold `[ADR-0037-D5]`. No administrative command may unilaterally release a quarantined gate without verified physical quiescence.
4. **No Autonomous Model Execution Wiring**: Model inference loops will not be coupled to the Docker execution adapter during this milestone.
5. **No Proprietary Cloud APIs or Paid Infrastructure**: Preserve the strict ₹0-cost constraint.

---

## 3. Existing Capabilities and Dependencies

### 3.1 Component Architecture Map

```
┌────────────────────────────────────────────────────────┐
│                   CLI / Host Layer                     │
│  bin/emerald.js (doctor, recovery sweep, submit)       │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│                  Application Layer                     │
│  - WorkerRuntime (executes attempts, fences gates)     │
│  - RunCoordinator (manages leases, retries)            │
│  - RecoverySupervisor (recovers uncommitted mutations) │
│  - RecoverySweeper (two-phase sweep coordinator)       │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│                    Domain Layer                        │
│  - ExecutionPolicy (derives isolation requirements)    │
│  - StepController (governed step execution)            │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│                     Ports Layer                        │
│  - ExecutionProviderPort (execute, cancel)             │
│  - TenantQuiescencePort (probeQuiescence, terminate)   │
│  - StateStorePort (durable persistence)                │
└─────────────┬───────────────────────────┬──────────────┘
              │                           │
┌─────────────▼───────────────┐ ┌─────────▼──────────────┐
│     Execution Adapters      │ │  Coordination Adapters │
│ - InProcessExecutionProvider│ │ - SqliteTenantLaunch-  │
│ - DockerExecutionProvider   │ │   Coordinator          │
│   (create/start split)      │ │ - SqliteStateStore     │
│ - DockerTenantQuiescence-   │ │   (WAL mode, durable   │
│   Adapter (label discovery) │ │   gates & quarantine)  │
└─────────────────────────────┘ └────────────────────────┘
```

### 3.2 Implemented Invariants and Existing Tests

| Module | Implemented Invariant / Contract | Test Suite | Test Count & Status |
|---|---|---|---|
| `DockerExecutionProvider` | Two-phase `docker create` and `docker start` split; inert container validation; single-flight termination; container ID regex checking. | `tests/adapters/docker-cancellation.test.ts` | 35 passed |
| `SqliteTenantLaunchCoordinator` | Durable `QUARANTINED` gate state; anti-stealing under quarantine; token-fenced gate release; supervisor exclusivity. | `tests/recovery/tenant-launch-coordinator.test.ts` | 48 passed |
| `RecoverySupervisor` & `RetryCoordinator` | Execution quiescence prerequisite before workspace rollback, mutation, or retry; fail-closed handling of unverified runs. | `tests/recovery/direct-recovery-safety-boundary.test.ts` | 67 passed |
| `RecoverySupervisor` | Durable supervisor exclusivity; dead-PID lease takeover; PID validation fail-closed. | `tests/recovery/recovery-authority-exclusivity.test.ts` | 14 passed |
| `NodeFsWorkspaceAdapter` | Workspace-owned disposal gate; prevents uncoordinated deletion of active workspaces. | `tests/adapters/node-fs-workspace-owned-disposal.test.ts` | 79 passed |
| `DockerExecutionProvider` (Live) | Real-daemon cancellation lifecycle, stop->kill->rm, label isolation, and late-start race probe. | `tests/integration/docker-cancellation.integration.test.ts` | 9 scenario groups (Opt-in, not yet run in M2.4B) |

---

## 4. Safety Invariants

Milestone 2.4B strictly enforces all existing master architectural invariants:

1. **Durable Recovery Authority & Token Fencing (ADR-0041)**:
   - A tenant launch gate can only be released by the entity holding its exact, unique acquisition token.
   - Stale workers or dead supervisors cannot release gates acquired by another epoch.
2. **Fail-Closed Durable Quarantine (ADR-0041)**:
   - If container termination cannot be affirmatively verified (`TERMINATION_UNVERIFIED`), the gate transitions to `QUARANTINED`.
   - While `QUARANTINED`, worker acquisition requests fail closed (`TenantLaunchGateConflictError`).
   - Gate TTL expiration never permits a worker to steal a quarantined gate.
3. **Execution Quiescence Prerequisite (ADR-0037, ADR-0041)**:
   - No recovery service (`RetryCoordinator`, `RecoverySupervisor`, or `RecoverySweeper`) may dispose, roll back, mutate, or requeue an isolated run's workspace unless tenant quiescence has been affirmatively verified (`status === "QUIESCENT"` with 0 live containers) in the current epoch.
4. **Inert Container Invariant (ADR-0040)**:
   - Containers created via `docker create` remain inert with 0 running processes until `docker start` is called.
   - If a cancellation signal or timeout fires prior to `docker start`, the container is disposed of without active filesystem mutations.
5. **Fail-Closed Process Liveness Checks**:
   - Process existence probes (`isProcessAlive(pid)`) must fail closed on missing, invalid, or indeterminate PID values.
6. **At-Least-Once Delivery Semantics**:
   - No component claims exactly-once execution. Requeuing and retries occur strictly after affirmative quiescence verification.
7. **Isolated Adapter Boundary (ADR-0039)**:
   - `DockerExecutionProvider` remains an isolated test and research adapter. It must never be exposed as the default production execution provider without explicit ADR re-authorization.
8. **Preservation of Repository Integrity**:
   - Zero modifications to user workspace files or Git history.
9. **Empirical Boundedness of Race Probes**:
   - As established in ADR-0037 §4.6, ADR-0038, and `tests/integration/docker-cancellation.integration.test.ts`, finite test executions (such as Scenario 7's 20-delay probe) provide bounded empirical evidence under specific host conditions, not formal mathematical proof that every conceivable kernel-scheduling, host-load, or Docker daemon race is eliminated. Fail-closed coordination gates (`QUARANTINED` status, token fencing, and supervisor exclusivity) remain the authoritative defense-in-depth safety boundaries.

---

## 5. Acceptance Criteria

Milestone 2.4B is complete when the following objective, verifiable criteria are satisfied:

### AC-1: Bounded Unit Test Baseline Maintained
- All 243 core safety, recovery, cancellation, and workspace disposal unit tests pass with exit code 0:
  ```bash
  npx vitest run \
    tests/adapters/docker-cancellation.test.ts \
    tests/recovery/recovery-authority-exclusivity.test.ts \
    tests/recovery/tenant-launch-coordinator.test.ts \
    tests/recovery/direct-recovery-safety-boundary.test.ts \
    tests/adapters/node-fs-workspace-owned-disposal.test.ts
  ```

### AC-2: TypeScript Baseline Diagnostic Gate Passes
- `node scripts/ci/check-tsc-baseline.js` passes with exit code 0, verifying 0 new diagnostic signatures introduced beyond the pinned 287 baseline signatures.

### AC-3: Authorized Live Docker Rehearsal Passes (Opt-In)
- When executed under an authorized run with `EMERALD_DOCKER_INTEGRATION=1`, all 9 scenario groups in `tests/integration/docker-cancellation.integration.test.ts` pass against the local Docker daemon:
  - Scenario 1: Timeout reports `TIMED_OUT` with verified termination and empty container set.
  - Scenario 2: Mid-execution cancellation yields `CANCELLED` matching actual container state.
  - Scenario 3: Workspace write-after-cancel stability.
  - Scenario 4: Graceful stop and forced-termination paths (subcases: SIGTERM-ignoring workload, cooperative workload).
  - Scenario 5: Provider stop/kill failure vs quiescence verifier failure (subcases: 5a stop/kill fail + verifier succeeds, 5b stop/kill fail + verifier fails -> `TERMINATION_UNVERIFIED`, 5c verifier fails while stop works -> never `CANCELLED`).
  - Scenario 6: Local CLI exit is not proof container stopped (subcases: 6a raw CLI killed leaves container running, 6b provider whose CLI is killed externally does not return while container still running).
  - Scenario 7: Late-start race probe showing 0 container leaks across 20 abort delays near process creation (provides bounded empirical evidence under tested conditions, not formal mathematical proof against all kernel or host-load races).
  - Scenario 8: Unverified termination lifecycle, durable quarantine, worker rejection, and recovery reap.
  - Scenario 9: Aggregate leak ledger verifying zero unexplained container residue.
*(Note: This suite is opt-in, requires separate human authorization to run, and has not yet been executed for Milestone 2.4B.)*

### AC-4: Architectural Resolution of ADR-0037-D3 Documented
- ADR-0042 authored and marked ACCEPTED following project owner approval in F-6.7, formalizing Alternative C (Layered Defense-in-Depth Model), preserving universal image portability, and rejecting mandatory entrypoint wrappers.

### AC-5: Read-Only Quarantine Diagnostic Visibility
- Operators can query and inspect the quarantine status of runs via an inspectable, non-destructive diagnostic interface that displays existing persisted fields from `tenant_launch_gates`:
  - Run ID (`run_id`)
  - Holder type (`holder_type`)
  - Holder ID (`holder_id`)
  - State (`state`)
  - Acquired timestamp (`acquired_at`)
  - Expiration timestamp (`expires_at`)
  - Release timestamp (`released_at`)
  - Owner PID (`owner_pid`)
*(Note: Source code inspection confirms that `tenant_launch_gates` in SQLite does not persist a `reason` column; diagnostic output is strictly bounded to existing schema fields unless a separate schema migration is authorized.)*

---

## 6. Verification Plan

### Stage 1: Fast Deterministic Verification (Offline / In-Memory)
- **Scope**: Run unit tests in-memory with mocked process runners and SQLite WAL mode.
- **Prerequisites**: Node.js v22+, npm dependencies installed.
- **Command**:
  ```bash
  npm run test:fast  # or explicit vitest command targeting the 5 core suites
  ```
- **Expectation**: 243 passed tests, 0 failures, 0 skipped, duration < 15 seconds.

### Stage 2: POSIX Integrity & TypeScript Baseline Gate
- **Scope**: Verify that no type signatures or compiler contracts have regressed.
- **Command**:
  ```bash
  node scripts/ci/check-tsc-baseline.js
  ```
- **Expectation**: Exit code 0, 0 new diagnostic signatures.

### Stage 3: Controlled Live Docker Integration Rehearsal (Authorized Only)
- **Scope**: Live Docker daemon integration test (`tests/integration/docker-cancellation.integration.test.ts`).
- **Safety Controls**:
  - Local image `node:22-alpine` only; **strictly zero network pulls**.
  - `--network=none` enforced on all test containers.
  - Isolated temporary directory mounts under `os.tmpdir()`.
  - Unique label filtering (`emerald.run=rehearsal-cancel-<uuid>`).
  - Strict bounded timeout (90 seconds).
  - Explicit teardown hooks verifying zero leaked containers.
- **Command**:
  ```bash
  EMERALD_DOCKER_INTEGRATION=1 npx vitest run tests/integration/docker-cancellation.integration.test.ts
  ```
- **Expectation**: 9 passed scenario groups, 0 container leaks, exit code 0.

---

## 7. Risks and Unresolved Decisions

The following decisions require explicit owner or lead engineer approval:

### Decision 1: Scope of ADR-0037-D3 (Resolved in ADR-0042)
- **Status**: RESOLVED (Alternative C approved in F-6.7).
- **Resolution**: Host-side primary timeout with recovery sweeper fencing and inert-container lifecycle adopted; mandatory entrypoint wrapping rejected to preserve compatibility with minimal/distroless images.

### Decision 2: Operator Override for Quarantined Runs (`[ADR-0037-D5]`)
- **Issue**: When a run is `QUARANTINED`, workers cannot touch it. Only `RECOVERY` can take over after confirming physical quiescence. Should an administrative CLI command exist to force-clear quarantine, or must clearance occur strictly via verified `recovery sweep`?
- **Trade-off**: An administrative `--force` flag creates risk of human error or operator-induced split-brain execution if live containers exist. Fail-closed architecture prefers requiring recovery to verify zero containers before clearing quarantine.
- **Recommendation**: Maintain read-only diagnostic inspection first; defer force-release tooling until proven necessary.

---

## 8. Proposed Implementation Breakdown

The following sequence of bounded tasks is recommended for Milestone 2.4B:

1. **Task F-6.2 — Milestone 2.4B Scope Approval & Architecture Review**:
   - Human review and formal approval of this specification document.
2. **Task F-6.3 — Architectural Evaluation of ADR-0037-D3**:
   - Document decision on container-side timeout wrappers vs host-side process reaping.
3. **Task F-6.4 — Authorized Live Docker Integration Rehearsal**:
   - Execute `tests/integration/docker-cancellation.integration.test.ts` against the local Docker daemon and record evidence bundle.
4. **Task F-6.5 — Read-Only Quarantine Diagnostic Inspection**:
   - Implement read-only CLI status reporting for `tenant_launch_gates` in `QUARANTINED` status.
5. **Task F-6.6 — Milestone 2.4B Checkpoint & Audit**:
   - Final verification baseline, evidence bundle archiving, and readiness assessment for Milestone 2.5.

---

## 9. Cost and Model Policy

- **Zero-Cost Constraint**: The entire milestone operates at ₹0 cost. No commercial cloud model APIs, paid SaaS services, or proprietary infrastructures may be used.
- **Local Inference**: Any future agent brain evaluation must use local open-weight models (e.g. Ollama 3B coder models on local CPU/RAM) or deterministic mocks.
- **Confinement**: All integration tests must run against local resources without external network calls or cloud infrastructure dependencies.
