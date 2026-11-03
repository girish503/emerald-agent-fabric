# ADR-0042: Container Timeout Strategy and Workload Lifetime Containment (Resolution of ADR-0037-D3)

## 1. Status
- **Status**: ACCEPTED (Approved by Project Owner in Milestone 2.4B Checkpoint F-6.7)
- **Date**: 2026-11-02
- **Relates to**:
  - [ADR-0037: Tenant Quiescence Before Recovery Mutates or Disposes a Workspace](./ADR-0037-tenant-quiescence-before-workspace-mutation-by-recovery.md) (Decision D3)
  - [ADR-0038: Close Late-Start Tenant Race with Coordination Gate](./ADR-0038-close-late-start-tenant-race-with-coordination-gate.md)
  - [ADR-0039: CI Quality Baseline and POSIX Integrity Gate](./ADR-0039-ci-quality-baseline-and-posix-integrity.md) (Deferred `[ADR-0037-D3]`)
  - [ADR-0040: Docker Create/Start Lifecycle Split for Late-Start Race Reduction](./ADR-0040-docker-create-start-split.md)
  - [ADR-0041: Recovery Safety Boundary Remediation: Direct Invocations, Durable Quarantine, and Fenced Re-Execution](./ADR-0041-recovery-safety-boundary-remediation.md)
  - [Milestone 2.4B Specification](../product/milestone-2.4b-specification.md)
- **Not a claim**: This record does not claim that a host-side timer survives host process destruction, does not assume a `timeout` binary exists in arbitrary container images, does not claim that live Docker rehearsal has been executed for Milestone 2.4B, and does not promise exactly-once execution or formal mathematical elimination of all kernel races.

---

## 2. Context & The ADR-0037-D3 Question

In ADR-0037 Section 7, Decision D3 raised a fundamental architectural question regarding container execution bounds:
> **Question (ADR-0037-D3)**: Should Emerald enforce container execution limits via a container-side maximum lifetime timeout wrapper (e.g. an entrypoint script or GNU `timeout` binary prepended to the workload, altering the image contract), or should it rely on host-side timer management and recovery reaping?

In ADR-0039 Section 1, decision `[ADR-0037-D3]` was explicitly deferred to Milestone 2 to prioritize baseline CI establishment and recovery safety invariants.

### Evolution of the Execution Architecture
Subsequent milestones introduced foundational execution and recovery mechanisms:
1. **ADR-0040 (Docker Create/Start Split — Existing Implementation)**:
   Replaced monolithic `docker run` in `DockerExecutionProvider` with a two-phase lifecycle (`docker create` followed by container ID regex validation, pre-start abort checks, and `docker start`). When cancellation or timeout is detected before `docker start` is dispatched, the container remains in an inert `created` state with zero running OS processes. However, if cancellation arrives while `docker start` is already in flight or committed to the daemon, a race may still occur; therefore, post-creation cancellation checks, physical termination verification, and recovery coordination remain essential defense-in-depth boundaries.
2. **ADR-0041 (Recovery Safety Boundary Remediation — Existing Implementation)**:
   Introduced durable `QUARANTINED` launch gates in SQLite, anti-stealing under quarantine, supervisor exclusivity, and the invariant that no recovery service may roll back, dispose, or requeue workspaces until tenant quiescence has been affirmatively verified.

### Current Implementation and Test Status
- **Existing Implementation**:
  - `DockerExecutionProvider` (`src/adapters/execution/docker-execution-provider.ts`): Implements host-side `setTimeout`, two-phase create/start lifecycle, and single-flight `stop -> kill -> verify` termination.
  - `SqliteTenantLaunchCoordinator` (`src/adapters/coordination/sqlite-tenant-launch-coordinator.ts`): Implements durable launch gates, token fencing, and fail-closed quarantine.
  - `RecoverySupervisor` & `RecoverySweeper` (`src/recovery/`): Enforces quiescence prerequisites before mutation or requeue.
- **Existing Unit-Test Evidence**:
  - 243 deterministic unit tests pass offline (including `docker-cancellation.test.ts`, `tenant-launch-coordinator.test.ts`, and `direct-recovery-safety-boundary.test.ts`).
- **Live Integration Rehearsal Status**:
  - `tests/integration/docker-cancellation.integration.test.ts` defines 9 scenario groups testing live cancellation, stop/kill escalation, unverified termination, and late-start race probing. This suite is opt-in (`EMERALD_DOCKER_INTEGRATION=1`) and was authorized by the project owner in F-6.7 for controlled execution in Task F-7.2.
- **Architectural Scope**:
  - Resolution of `[ADR-0037-D3]` formally adopting Alternative C and rejecting mandatory container-side entrypoint modification.

---

## 3. Decision Drivers

1. **Fail-Closed Safety**: In the event of process crashes, daemon communication drops, or power failures, tenant containers must never be allowed to execute unmonitored concurrent mutations against an isolated workspace.
2. **Image Portability & Universal Compatibility**: Emerald must support arbitrary developer-selected container images (standard Linux distributions, minimal Alpine images, distroless images, scratch containers, and custom binaries) without imposing rigid entrypoint contracts or mandatory shell utilities.
3. **Operational Simplicity**: Minimize the need for custom image authoring, dynamic volume mounting of host binaries, or fragile entrypoint rewriting.
4. **Resilience to Host Worker Death**: Acknowledge that host-side JavaScript timers (`setTimeout`) die immediately if the host Node.js process is killed via `SIGKILL`, crashes, or loses power.
5. **Lease Expiry vs Termination Reality**: Worker lease expiration renders a run eligible for recovery; it does not constitute physical proof of process death. Actual termination requires affirmative daemon interaction.
6. **Clear Separation of Concerns**: Maintain explicit boundaries between execution providers (attempt-level dispatch), launch coordinators (mutual exclusion), and recovery hosts (crash consistency).

---

## 4. Options Considered

### Alternative A: Exclusive Host-Side Timeout and Recovery Reaping
- **Design**:
  - The host-side `DockerExecutionProvider` sets a JavaScript timer (`setTimeout`) bounded to `request.timeoutMs`.
  - When the timer expires, the provider initiates single-flight termination (`docker stop -t 2`, followed if necessary by `docker kill` and `docker rm -f`).
  - If the host worker process exits or crashes unexpectedly, the container continues executing in the Docker daemon until the worker's lease expires (`leaseTtlMs`, default 30s).
  - Lease expiry triggers recovery eligibility. The `RecoverySweeper` queries containers carrying the `emerald.run=<runId>` label, attempts termination via `DockerTenantQuiescenceAdapter`, and verifies physical quiescence before advancing the run.
- **Safety Properties & Failure Modes**:
  - *Host Crash*: Container continues running until recovery runs and successfully terminates it. Workspace remains protected because the launch gate remains locked and no worker can acquire the run while the gate remains unreleased.
  - *Daemon Unavailability*: If Docker stops responding, quiescence verification fails, and the gate transitions to `QUARANTINED` (fail-closed).
- **Image Compatibility**: 100% universal. Works with any valid OCI image without requiring `/bin/sh`, Coreutils, or custom entrypoint wrappers.
- **Limitations & Unknowns**: If a host worker dies abruptly, container execution is not bounded by a deterministic host timer. The duration of orphaned execution depends on when recovery runs, whether the Docker daemon is responsive, and whether physical quiescence can be verified. There is no strict wall-clock upper bound on orphan execution if recovery is delayed or the daemon hangs.

### Alternative B: Mandatory Container-Side Timeout Wrapper (Entrypoint Modification)
- **Design**:
  - Wrap the workload command inside the container using an entrypoint utility such as GNU `timeout <duration>` or an injected supervisor script.
  - The container engine enforces execution duration internally, terminating the inner process regardless of host process health.
- **Safety Properties & Failure Modes**:
  - *Host Crash*: The inner workload self-terminates when its internal timer expires, reducing the window of active process execution inside the container.
  - *Daemon Unavailability*: Even though the inner workload terminates, the host and recovery services still cannot verify physical container termination without querying the Docker daemon. Therefore, recovery must still fail closed into `QUARANTINED`.
- **Image Compatibility**: **Severe compatibility breakdown**.
  - Distroless images (`gcr.io/distroless/*`), scratch containers, and minimal runtimes lack `/bin/sh` or `/usr/bin/timeout`. Prepending `timeout` causes immediate container execution failures (`executable file not found`).
  - Injecting a statically compiled host binary via a bind-mounted volume introduces cross-architecture mismatches (e.g. host x86_64 vs container arm64), violates read-only container filesystem policies, and requires root or elevated container permissions to execute.
- **Trade-off**: Imposes severe image restrictions and operational complexity while failing to eliminate the need for recovery-side daemon quiescence verification.

### Alternative C: Layered Defense-in-Depth Model (Primary Host Control, Durable Recovery Fencing, and Clarified Daemon Limits)
- **Design**:
  - **Tier 1 (Host-Side Execution Control — Existing Implementation)**: `DockerExecutionProvider` manages primary execution timeout via bounded `setTimeout` and ADR-0040's two-phase `docker create` / `docker start` lifecycle. Pre-start abort checks prevent launching containers if cancelled prior to dispatch.
  - **Tier 2 (Durable Recovery Fencing & Quarantine — Existing Implementation)**: If the host worker process dies, SQLite WAL-persisted lease fencing (`leaseTtlMs`) and launch gate authority prevent any other worker from touching the workspace. Lease expiry allows `RecoverySweeper` to take over, discover lingering containers via `emerald.run=<runId>` labels, and attempt physical termination. If quiescence cannot be verified, the gate remains `QUARANTINED`.
  - **Tier 3 (Docker Stop Grace Period Semantics — Clarification)**: Clarify Docker's `--stop-timeout` flag: this setting controls only the grace period between SIGTERM and SIGKILL *after* a `docker stop` command is issued by the host or recovery. It does **not** provide an autonomous maximum-lifetime timer that self-terminates a workload after elapsed execution time.
  - **Tier 4 (Optional Advisory Workload Wrappers — Proposed)**: For specialized tasks that explicitly provide their own self-terminating wrapper scripts, the provider may accept optional execution hints, but will *never* mandate them across general images.

---

## 5. Comparative Evaluation Matrix

| Criterion | Alternative A: Host-Side & Recovery Only | Alternative B: Mandatory Container-Side Wrapper | Alternative C: Layered Defense-in-Depth (Proposed) |
|---|---|---|---|
| **Universal Image Compatibility** | **Full**: Arbitrary OCI images supported. | **Broken**: Fails on distroless, scratch, and minimal images. | **Full**: Zero image contract requirements. |
| **Worker Crash Containment** | Recovery eligibility upon lease expiry; actual termination requires recovery sweeper and responsive daemon. | Workload inner process self-terminates at timeout boundary. | Recovery eligibility upon lease expiry; actual termination requires recovery sweeper and responsive daemon. |
| **Docker Daemon Failure Handling** | Fails closed into `QUARANTINED` gate. | Fails closed into `QUARANTINED` gate (still unverified). | Fails closed into `QUARANTINED` gate. |
| **Operational Complexity** | **Low**: Standard Node.js timers and Docker CLI. | **High**: Image rewriting, binary injection, architecture matching. | **Low**: Standard timers, clear boundaries, zero image tampering. |
| **Quiescence Verification Dependency** | Requires affirmative proof before mutation. | Requires affirmative proof before mutation (unchanged). | Requires affirmative proof before mutation. |
| **At-Least-Once Delivery Alignment** | Full alignment with ADR-0036/0037/0041. | Full alignment with ADR-0036/0037/0041. | Full alignment with ADR-0036/0037/0041. |

---

## 6. Decision & Rationale

### Decision
**Formally resolve `[ADR-0037-D3]` by REJECTING mandatory container-side entrypoint timeout wrappers and ADOPTING Alternative C (Layered Defense-in-Depth Model).** The project owner explicitly approved this architecture in Milestone 2.4B Checkpoint F-6.7.

### Rationale
1. **Container Abstraction Integrity**: Forcing a container-side `timeout` wrapper violates OCI image abstraction. A software-engineering agent runtime must execute arbitrary developer repositories and test containers without demanding that every container base image package GNU Coreutils or execute a custom shell.
2. **False Sense of Security**: Alternative B does not eliminate external recovery verification. Even if an internal process exits cleanly, the recovery coordinator cannot rely on container claims; it must still affirmatively query the Docker daemon and verify that zero containers remain before releasing workspaces or requeuing runs.
3. **Conditional Containment via Recovery Fencing**: Under Alternative C, if a worker process experiences an abrupt catastrophic termination (SIGKILL or power loss), workspace isolation is preserved by durable SQLite gate fencing. While lease expiration (~30s) triggers recovery eligibility, physical termination depends on the recovery sweeper successfully contacting the Docker daemon, terminating containers, and confirming quiescence. If termination cannot be verified, the run remains `QUARANTINED`, preserving fail-closed safety.
4. **ADR-0040 Create/Start Lifecycle**: Splitting `docker create` from `docker start` allows cancellation or timeout handling to prevent starting the container when detected before start dispatch, reducing late-start risks without requiring image modifications.

---

## 7. Consequences & Trade-offs

### Positive Consequences
- **Uncompromised Image Compatibility**: Emerald can safely execute workflows in distroless, scratch, Alpine, Debian, Ubuntu, or custom toolchain images.
- **Zero Architecture Injection Fragility**: Eliminates cross-compilation and volume-mounting requirements for host-injected helper binaries.
- **Consistent Governance**: All timeouts, cancellations, and quarantines remain observable in host-side SQLite telemetry and audit logs.
- **Strict Adherence to ₹0 Cost & Local Policy**: Introduces zero external dependencies or proprietary supervision agents.

### Explicit Trade-offs & Limitations
- **No Strict Wall-Clock Orphan Bound During Worker Crash**: If a worker process is terminated via uncatchable `SIGKILL` while a container is actively running:
  - Container execution is not bounded by the dead host-side timer.
  - Worker lease expiry (~30s) marks the run eligible for recovery, but does not prove process termination.
  - Actual termination depends on a recovery sweeper pass executing and successfully communicating with the Docker daemon.
  - *Safety Guarantee*: The isolated workspace remains protected by the locked launch gate; no other worker can acquire the gate or modify the workspace while the gate remains unreleased. If recovery cannot confirm termination, the gate transitions to `QUARANTINED`.
- **Docker Daemon Dependency**: If the Docker daemon freezes, neither host timers nor recovery can guarantee termination; this condition is correctly caught by ADR-0041 and transitions the run into durable `QUARANTINED` status.

---

## 8. Preserved Recovery and Quarantine Invariants

This decision strictly preserves all established master architectural invariants:

1. **Affirmative Quiescence Prerequisite (ADR-0037, ADR-0041)**:
   Recovery services (`RetryCoordinator`, `RecoverySupervisor`, `RecoverySweeper`) must never roll back, dispose, or requeue an isolated run's workspace unless tenant quiescence has been affirmatively verified (`status === "QUIESCENT"` with 0 live containers) in the current epoch.
2. **Lease Expiry is Not Proof of Termination (ADR-0037, ADR-0041)**:
   A lapsed worker lease triggers recovery eligibility; it does not prove that tenant containers have ceased execution. Workspace mutations remain prohibited until physical quiescence is proven.
3. **Fail-Closed Durable Quarantine (ADR-0041)**:
   If container termination cannot be confirmed (`TERMINATION_UNVERIFIED`), the launch gate transitions to `QUARANTINED`. Workers are strictly blocked from acquiring quarantined gates regardless of TTL expiration.
4. **Supervisor Exclusivity & Token Fencing (ADR-0041)**:
   Only an authorized recovery supervisor may acquire a quarantined gate to probe daemon status and remediate surviving processes. All gate operations require valid acquisition tokens.
5. **Inert Container Invariant & Cancellation Bounds (ADR-0040)**:
   Containers created via `docker create` remain inert until `docker start`. Aborts detected prior to `docker start` dispatch dispose of the container without activating running processes. When cancellation is concurrent with start, termination verification and quarantine remain authoritative.
6. **At-Least-Once Delivery**:
   Requeuing and retries occur strictly after affirmative quiescence verification; exactly-once execution is never claimed.

---

## 9. Required Follow-up Validation Before Implementation

Before this proposed decision is finalized and Milestone 2.4B implementation begins:
1. **Authorized Live Docker Rehearsal**: Execute `tests/integration/docker-cancellation.integration.test.ts` under explicit human authorization (`EMERALD_DOCKER_INTEGRATION=1`) to observe real-daemon behavior for host-side cancellation, forced stop/kill escalation, and recovery sweeper reaping.
2. **Grace Period Calibration**: Validate that provider stop grace periods (`stopGraceSeconds: 2`) and termination timeouts (`terminationTimeoutMs: 15_000`) provide reliable graceful-to-forceful escalation across host operating environments.

---

## 10. Owner Decision Record (F-6.7)

1. **Decision A (ADR-0042 Resolution)**: **APPROVED**. Alternative C (Layered Defense-in-Depth Model) is formally accepted; mandatory container-side entrypoint timeout wrappers are rejected.
2. **Decision B (Live Rehearsal Authorization)**: **AUTHORIZED**. The project owner explicitly authorized executing `tests/integration/docker-cancellation.integration.test.ts` under bounded pre-verified parameters (isolated temporary directories, rehearsal-specific labels, `--network=none`, zero network image pulls).
3. **Decision C (Quarantine Diagnostics Boundary)**: **APPROVED**. The project owner approved scoping `emerald recovery status` as a strictly read-only diagnostic query command displaying exclusively the eight existing SQLite columns in `tenant_launch_gates`, prohibiting schema migrations or force-release tooling.
