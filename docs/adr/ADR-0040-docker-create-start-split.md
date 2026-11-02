# ADR-0040: Docker Create/Start Lifecycle Split for Late-Start Race Reduction

## 1. Status
- **Status**: ACCEPTED.
- **Date**: 2026-11-01
- **Relates to**: ADR-0037 (tenant quiescence before workspace mutation), ADR-0038 (close late-start race with coordination gate), ADR-0039 (CI quality baseline and POSIX integrity)
- **Not a claim**: This design does not claim to make every conceivable distributed race impossible across an arbitrary Docker daemon host; it systematically eliminates the unconstrained running-container late-start race by splitting container instantiation from process activation.

---

## 2. Context & Motivation

In previous milestones, `DockerExecutionProvider` executed tenant operations using a single `docker run` command via `child_process.spawn`.

Under the monolithic `docker run` model, container creation and container execution were combined into a single atomic daemon operation. If the local worker process experienced an abort, timeout, crash, or CLI process termination while `docker run` was in flight:
1. The Docker daemon might receive and accept the request after the local CLI process terminated.
2. The container would immediately transition into the `running` state inside the Docker engine.
3. If recovery or a subsequent worker swept the workspace before the container appeared or was discovered, the container could start running and writing to workspace mounts *after* quiescence had observed zero containers.

While ADR-0038 introduced the durable `tenant_launch_gates` SQLite coordination gate to synchronize recovery sweeps with worker tenant launches, the execution provider itself needed defense-in-depth to prevent an in-flight create request from launching an untracked, actively executing container.

---

## 3. Decision

We replace the monolithic `docker run` lifecycle in `DockerExecutionProvider` with a two-phase lifecycle:
1. `docker create` via the injectable, bounded `commandRunner`.
2. Strict validation of the returned container ID.
3. Post-creation cancellation and timeout check.
4. `docker start -a` (with `-i` only for operations requiring interactive standard input) via `spawnProcess`.

---

## 4. Lifecycle & State Machine Transitions

```
[Request Received]
        │
        ▼
 (Pre-abort check) ──(aborted)──► [CANCELLED (No Docker commands)]
        │
        ▼
[Register Listeners & Timers]
        │
        ▼
[docker create] (with security flags, resource limits, labels, mounts)
        │
        ├─► (Spawn failure / daemon error) ──► [PROVIDER_UNAVAILABLE]
        ├─► (Non-zero exit) ────────────────► [EXECUTION_FAILED]
        ├─► (Malformed container ID) ───────► [Terminate by Name -> Fail Closed]
        │
        ▼ (Valid Container ID)
 (Post-create check) ──(aborted/timed out)──► [Terminate & Verify Quiescence -> CANCELLED/TIMED_OUT]
        │
        ▼ (Active)
[docker start -a [-i]] (using validated Container ID)
        │
        ├─► (Exit Code) ──────────────────► [Parse Output -> SUCCESS / FAILED]
        ├─► (Output Limit Exceeded) ───────► [Terminate & Verify Quiescence -> FAILED]
        ├─► (Timeout Exceeded) ────────────► [Terminate & Verify Quiescence -> TIMED_OUT]
        └─► (Abort Signal) ────────────────► [Terminate & Verify Quiescence -> CANCELLED]
```

### 4.1 Strict Container ID Validation
The stdout from `docker create` is validated against `/^[a-fA-F0-9]{12,64}$/`. If Docker returns unexpected output, whitespace corruption, or a non-hex identifier, the provider:
1. Rejects the identifier immediately.
2. Invokes single-flight container termination targeting the deterministic `containerName`.
3. Verifies tenant quiescence.
4. Fails closed with `EXECUTION_FAILED` or `TERMINATION_UNVERIFIED`.

### 4.2 Inert Container Invariant
A container instantiated via `docker create` remains in the `created` status in the Docker engine. It has zero running OS processes, consumes no CPU, executes no commands, and cannot mutate the workspace directory.

If the client process is aborted or times out before `docker start` is invoked, the container never transitions to `running`. The cleanup routine disposes of an inert entity without risk of active mutations.

---

## 5. Lost Create Responses and Inert-Container Cleanup

If a `docker create` request is accepted by the Docker daemon but the client connection drops or times out before receiving the stdout container ID:
1. The container was created with a deterministic name: `run-<runId>-<attemptNumber>-<operationName>`.
2. The container was created with full metadata labels:
   - `emerald.run`: The authoritative run ID.
   - `emerald.attempt`: The attempt sequence number.
   - `emerald.lease`: The active worker lease.
   - `emerald.worker`: The executing worker ID.
   - `emerald.provider`: `"docker"`.
3. The catch block in `execute` invokes single-flight `terminateContainer(containerName, ...)`.
4. `DockerTenantQuiescenceAdapter` queries `docker ps -a --filter label=emerald.run=<runId>` which finds all containers regardless of state (`created`, `running`, `paused`, `restarting`, `exited`, `dead`).
5. Quiescence verification ensures that no container associated with `runId` remains before recovery or subsequent attempts advance.

---

## 6. Single-Flight Termination & Quiescence Verification

All cancellation, timeout, output limit violations, and cleanup paths route through the existing single-flight `terminateContainer`:
1. **Stage A (Graceful Stop)**: Issues `docker stop -t 2 <containerName>`. If exit code is 0, waits for child process close and verifies quiescence.
2. **Stage B (Force Kill)**: If graceful stop fails or times out, issues `docker kill <containerName>`.
3. **Stage C (CLI Exit)**: Awaits subprocess close event up to `terminationTimeoutMs`.
4. **Stage D (Quiescence Verification)**: Invokes `quiescencePort.quiesceRun(runId)`.
5. **Fail-Closed Guarantee**: If quiescence cannot be verified (e.g., daemon unavailable, malformed `docker ps` output, containers lingering), the provider returns `status: "FAILED"`, `error.code: "TERMINATION_UNVERIFIED"`. Cancellation or success is never reported unless termination is positively verified.

---

## 7. Preservation of Execution Contracts

1. **Security Flags**: Full isolation flags remain identical on `docker create`: `--network=none`, `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--memory`, `--cpus`, `--pids-limit`, and tmpfs mounts.
2. **Operation Contracts**:
   - Mechanical operations (`echo`, `sum`, etc.) receive input payload via piped stdin; started with `docker start -a -i`.
   - `run_command` receives arguments in `createArgs` and does not pipe stdin; started with `docker start -a` (without `-i`).
3. **Standard Streams**: Child stdout and stderr are captured, bounded by `maxOutputBytes`, and parsed deterministically.

---

## 8. Why `cancellationModel` Remains `COOPERATIVE`

`DockerExecutionProvider.cancellationModel` remains set to `"COOPERATIVE"`.
Although the provider initiates physical termination via `docker stop` and `docker kill` upon receiving an abort signal or timeout:
1. Docker daemon operations are mediated over IPC/network sockets.
2. Kernel resource reclamation and process death can be delayed by uninterruptible I/O, driver issues, or daemon state machine latency.
3. In accordance with Section 1.3 and Section 34 of the Master Engineering Constitution, the architecture refuses to claim unconditional physical termination when distributed and OS-level boundaries prevent mathematical certainty.

---

## 9. Remaining Risks & Limitations

1. **Docker Daemon Concurrency**: If the Docker daemon itself hangs or experiences deadlock during `docker create` or `docker start`, operations rely on bounded client-side subprocess timeouts to fail closed.
2. **Daemon Crashes**: If the host Docker daemon crashes midway through container execution, containers may restart if configured with restart policies (Emerald explicitly avoids restart policies).
3. **Mocked Subprocess Testing**: The deterministic test suite validates command construction, flag propagation, error handling, and transition logic against injected mock runners. Live daemon behavior is verified via bounded manual rehearsals and isolated integration tests.
