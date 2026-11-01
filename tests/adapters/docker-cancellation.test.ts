import { EventEmitter, getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import {
  DockerChildProcess,
  DockerExecutionProvider,
} from "../../src/adapters/execution/docker-execution-provider.js";
import { DockerTenantQuiescenceAdapter } from "../../src/adapters/execution/docker-tenant-quiescence-adapter.js";
import type { SubprocessRunner } from "../../src/adapters/execution/docker-tenant-quiescence-adapter.js";
import { InProcessExecutionProvider } from "../../src/adapters/execution/in-process-execution-provider.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
  resolveProviderCancellationModel,
} from "../../src/ports/execution-provider.port.js";
import type { QuiescenceResult, TenantQuiescencePort } from "../../src/ports/tenant-quiescence.port.js";
import { createAndActivateContract } from "../application/test-helpers.js";

/**
 * Deterministic coverage of the Docker provider's cancellation lifecycle. No Docker daemon, binary or image is
 * touched: the `docker run` CLI, the stop/kill/rm commands and the quiescence port are all injected fakes.
 * What this proves: ordering, single-flight, result precedence and fail-closed reporting of the provider LOGIC.
 * What it cannot prove (needs an authorized live Docker rehearsal): that a real daemon honours stop/kill and
 * that real `docker ps` listings reflect reality.
 */

class FakeChild extends EventEmitter implements DockerChildProcess {
  readonly stdin = Object.assign(new EventEmitter(), { written: "", ended: false, write(c: string) { this.written += c; }, end() { this.ended = true; } });
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: string[] = [];
  /** When true, SIGKILL makes the CLI close (the normal case). */
  closeOnKill = true;
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
  exit(code: number, stdout = "", stderr = ""): void {
    if (stdout) this.stdout.emit("data", Buffer.from(stdout));
    if (stderr) this.stderr.emit("data", Buffer.from(stderr));
    this.emit("close", code, null);
  }
}

type Cmd = { args: readonly string[] };

function harness(opts?: {
  quiescence?: () => QuiescenceResult | Promise<QuiescenceResult>;
  command?: (args: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string } | Error;
  terminationTimeoutMs?: number;
  quiescencePort?: TenantQuiescencePort;
}) {
  const children: FakeChild[] = [];
  const spawned: Cmd[] = [];
  const commands: Cmd[] = [];
  const events: string[] = [];
  const quiescenceCalls: string[] = [];
  const commandRunner: SubprocessRunner = async (_file, args) => {
    commands.push({ args });
    events.push(`cmd:${args[0]}`);
    const r = opts?.command?.(args) ?? { exitCode: 0 };
    if (r instanceof Error) throw r;
    return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const quiescence: TenantQuiescencePort =
    opts?.quiescencePort ?? {
      async quiesceRun(runId: string) {
        quiescenceCalls.push(runId);
        events.push("quiesce");
        return (await opts?.quiescence?.()) ?? { status: "QUIESCENT", stopped: 1 };
      },
    };
  const provider = new DockerExecutionProvider({
    quiescence,
    commandRunner,
    terminationTimeoutMs: opts?.terminationTimeoutMs ?? 200,
    spawnProcess: (_f, args) => {
      const c = new FakeChild();
      children.push(c);
      spawned.push({ args });
      events.push("spawn");
      return c;
    },
  });
  return { provider, children, spawned, commands, events, quiescenceCalls };
}

const baseRequest = (over: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
  runId: "run-1",
  taskId: "task-1",
  operationName: "slow",
  inputPayload: null,
  idempotencyToken: "tok",
  attemptNumber: 0,
  timeoutMs: 5_000,
  ...over,
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function untilSpawned(h: ReturnType<typeof harness>): Promise<FakeChild> {
  while (h.children.length === 0) await tick();
  return h.children[0]!;
}

describe("DockerExecutionProvider cancellation lifecycle (deterministic, no Docker)", () => {
  it("1. pre-aborted signal creates no container and runs no docker command", async () => {
    const h = harness();
    const ac = new AbortController();
    ac.abort();
    const res = await h.provider.execute(baseRequest({ signal: ac.signal }));
    expect(res.status).toBe("CANCELLED");
    expect(res.providerMetadata).toMatchObject({ preAborted: true, containerCreated: false });
    expect(h.spawned).toHaveLength(0);
    expect(h.commands).toHaveLength(0);
    expect(h.quiescenceCalls).toHaveLength(0);
  });

  it("2/6. cancel immediately after spawn: CLI killed, graceful stop, then verified quiescence -> CANCELLED", async () => {
    const h = harness();
    const ac = new AbortController();
    const p = h.provider.execute(baseRequest({ signal: ac.signal }));
    await untilSpawned(h);
    ac.abort();
    const res = await p;
    expect(res.status).toBe("CANCELLED");
    expect(res.providerMetadata).toMatchObject({ terminationVerified: true });
    expect(h.children[0]!.kills).toEqual(["SIGKILL"]);
    // Ordering: stop is issued before verification; quiescence is the last word.
    expect(h.events.indexOf("cmd:stop")).toBeGreaterThan(h.events.indexOf("spawn"));
    expect(h.events.indexOf("quiesce")).toBeGreaterThan(h.events.indexOf("cmd:stop"));
    expect(h.quiescenceCalls).toEqual(["run-1"]);
    // Graceful stop uses the configured grace window (default 2s) against the named container.
    expect(h.commands[0]!.args.slice(0, 3)).toEqual(["stop", "-t", "2"]);
    expect(h.commands[0]!.args[3]).toMatch(/^emerald-run-/);
  });

  it("3. timeout triggers graceful termination and reports TIMED_OUT only after verification", async () => {
    const h = harness();
    const res = await h.provider.execute(baseRequest({ timeoutMs: 15 }));
    expect(res.status).toBe("TIMED_OUT");
    expect(res.providerMetadata).toMatchObject({ terminationVerified: true, physicalTerminationAttempted: true });
    expect(h.commands.map((c) => c.args[0])).toEqual(["stop"]); // no escalation needed
  });

  it("4. graceful stop failure escalates to forced kill", async () => {
    const h = harness({ command: (a) => (a[0] === "stop" ? { exitCode: 1, stderr: "stop failed" } : { exitCode: 0 }) });
    const res = await h.provider.execute(baseRequest({ timeoutMs: 15 }));
    expect(h.commands.map((c) => c.args[0])).toEqual(["stop", "kill"]);
    expect(res.status).toBe("TIMED_OUT");
  });

  it("5. local CLI killed by signal while the container may exist -> terminate + verify, never trusted", async () => {
    const h = harness({ quiescence: () => ({ status: "UNVERIFIED", reason: "container still listed" }) });
    const p = h.provider.execute(baseRequest());
    const child = await untilSpawned(h);
    child.emit("close", null, "SIGKILL"); // CLI died on its own (e.g. OOM-killed); daemon container unknown
    const res = await p;
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("TERMINATION_UNVERIFIED");
    expect(h.commands.map((c) => c.args[0])).toContain("stop");
  });

  it("5c. signal-killed CLI with verified quiescence is FAILED, never SUCCESS/exit 128 (run_command and operations)", async () => {
    for (const operationName of ["run_command", "echo"]) {
      const h = harness();
      const p = h.provider.execute(
        baseRequest({
          operationName,
          inputPayload: operationName === "run_command" ? { argv: ["sleep", "120"] } : 1,
        })
      );
      (await untilSpawned(h)).emit("close", null, "SIGKILL");
      const res = await p;
      expect(res.status, operationName).toBe("FAILED");
      expect(res.error?.code).toBe("EXECUTION_FAILED");
      expect(res.output).toBeUndefined();
      expect(res.providerMetadata).toMatchObject({ cliSignal: "SIGKILL", terminationVerified: true });
      expect(h.quiescenceCalls).toEqual(["run-1"]);
    }
  });

  it("7. container survives stop+kill -> FAILED/TERMINATION_UNVERIFIED, never TIMED_OUT", async () => {
    const h = harness({
      command: (a) => ({ exitCode: a[0] === "rm" ? 0 : 1, stderr: "nope" }),
      quiescence: () => ({ status: "UNVERIFIED", reason: "Containers remain after cleanup: abc123" }),
    });
    const res = await h.provider.execute(baseRequest({ timeoutMs: 15 }));
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("TERMINATION_UNVERIFIED");
    expect(res.error?.message).toContain("Containers remain");
    expect(res.providerMetadata).toMatchObject({ terminationVerified: false, terminationCause: "timeout" });
    expect(h.commands.map((c) => c.args[0])).toEqual(["stop", "kill"]);
  });

  it("8. Docker daemon unavailable during termination -> unverified (13: never verified cancellation)", async () => {
    const h = harness({
      command: () => new Error("Cannot connect to the Docker daemon"),
      quiescence: () => ({ status: "UNVERIFIED", reason: "Docker execution error during listing: daemon down" }),
    });
    const ac = new AbortController();
    const p = h.provider.execute(baseRequest({ signal: ac.signal }));
    await untilSpawned(h);
    ac.abort();
    const res = await p;
    expect(res.status).not.toBe("CANCELLED");
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("TERMINATION_UNVERIFIED");
    expect((res.error?.details as { stages: string[] }).stages.some((s) => s.startsWith("stop:error="))).toBe(true);
  });

  it("8b. a throwing quiescence port is also unverified", async () => {
    const h = harness({
      quiescencePort: {
        async quiesceRun() {
          throw new Error("boom");
        },
      },
    });
    const res = await h.provider.execute(baseRequest({ timeoutMs: 10 }));
    expect(res.error?.code).toBe("TERMINATION_UNVERIFIED");
  });

  it("9. malformed docker ps output from the real quiescence adapter is UNVERIFIED -> not TIMED_OUT", async () => {
    const adapterRunner: SubprocessRunner = async () => ({ exitCode: 0, stdout: "garbage with too many fields here", stderr: "" });
    const h = harness({ quiescencePort: new DockerTenantQuiescenceAdapter({ runner: adapterRunner }) });
    const res = await h.provider.execute(baseRequest({ timeoutMs: 10 }));
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("TERMINATION_UNVERIFIED");
    expect(res.error?.message).toContain("Malformed output");
  });

  it("5b. CLI never exits after SIGKILL -> unverified even if listing is empty", async () => {
    const h = harness({ terminationTimeoutMs: 30 });
    const p = h.provider.execute(baseRequest({ timeoutMs: 10 }));
    const child = await untilSpawned(h);
    child.closeOnKill = false;
    const res = await p;
    expect(res.error?.code).toBe("TERMINATION_UNVERIFIED");
    expect(res.error?.message).toContain("CLI did not exit");
  });

  it("10. cleanup (rm) failure after normal execution requires a quiescence verdict", async () => {
    const failRm = (a: readonly string[]) => (a[0] === "rm" ? { exitCode: 1, stderr: "rm failed" } : { exitCode: 0 });

    const ok = harness({ command: failRm });
    const p1 = ok.provider.execute(baseRequest({ operationName: "echo", inputPayload: { a: 1 } }));
    (await untilSpawned(ok)).exit(0, '{"a":1}');
    const r1 = await p1;
    expect(r1.status).toBe("SUCCESS"); // verified quiescent despite rm failure
    expect(ok.quiescenceCalls).toEqual(["run-1"]);

    const bad = harness({ command: failRm, quiescence: () => ({ status: "UNVERIFIED", reason: "daemon down" }) });
    const p2 = bad.provider.execute(baseRequest({ operationName: "echo", inputPayload: { a: 1 } }));
    (await untilSpawned(bad)).exit(0, '{"a":1}');
    const r2 = await p2;
    expect(r2.status).toBe("FAILED");
    expect(r2.error?.code).toBe("TERMINATION_UNVERIFIED");
  });

  it("10b. clean normal execution does not invoke quiescence", async () => {
    const h = harness();
    const p = h.provider.execute(baseRequest({ operationName: "echo", inputPayload: 7 }));
    (await untilSpawned(h)).exit(0, "7");
    const res = await p;
    expect(res.status).toBe("SUCCESS");
    expect(res.output).toBe(7);
    expect(h.quiescenceCalls).toHaveLength(0);
    expect(h.commands.map((c) => c.args[0])).toEqual(["rm"]);
  });

  it("11. concurrent timeout + abort start exactly one termination sequence", async () => {
    const h = harness();
    const ac = new AbortController();
    const p = h.provider.execute(baseRequest({ signal: ac.signal, timeoutMs: 5 }));
    await untilSpawned(h);
    ac.abort(); // lands alongside the timer
    await new Promise((r) => setTimeout(r, 12));
    ac.abort();
    const res = await p;
    expect(["TIMED_OUT", "CANCELLED"]).toContain(res.status);
    expect(h.commands.filter((c) => c.args[0] === "stop")).toHaveLength(1);
    expect(h.quiescenceCalls).toHaveLength(1);
    expect(h.children[0]!.kills).toEqual(["SIGKILL"]);
  });

  it("12. late successful output after timeout or cancel cannot override the winning result", async () => {
    const h = harness();
    const p = h.provider.execute(baseRequest({ operationName: "echo", inputPayload: 1, timeoutMs: 10 }));
    const child = await untilSpawned(h);
    child.closeOnKill = false;
    await new Promise((r) => setTimeout(r, 25)); // timeout fired, termination pending on CLI close
    child.exit(0, "1"); // late success + exit 0 lands mid-termination
    const res = await p;
    expect(res.status).toBe("TIMED_OUT");
    expect(res.output).toBeUndefined();

    const h2 = harness();
    const ac = new AbortController();
    const p2 = h2.provider.execute(baseRequest({ operationName: "echo", inputPayload: 1, signal: ac.signal }));
    const c2 = await untilSpawned(h2);
    c2.closeOnKill = false;
    ac.abort();
    c2.stdout.emit("data", Buffer.from("1"));
    c2.exit(0);
    const r2 = await p2;
    expect(r2.status).toBe("CANCELLED");
    expect(r2.output).toBeUndefined();
  });

  it("output flood terminates through the same verified lifecycle", async () => {
    const h = harness();
    const p = h.provider.execute(baseRequest({ operationName: "echo", inputPayload: 1 }));
    (await untilSpawned(h)).stdout.emit("data", Buffer.alloc(1024 * 1024 + 1));
    const res = await p;
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("EXECUTION_FAILED");
    expect(res.providerMetadata).toMatchObject({ outputLimitExceeded: true, terminationVerified: true });
    expect(h.commands[0]!.args[0]).toBe("stop");

    const h2 = harness({ quiescence: () => ({ status: "UNVERIFIED", reason: "x" }) });
    const p2 = h2.provider.execute(baseRequest({ operationName: "echo", inputPayload: 1 }));
    (await untilSpawned(h2)).stdout.emit("data", Buffer.alloc(1024 * 1024 + 1));
    expect((await p2).error?.code).toBe("TERMINATION_UNVERIFIED");
  });

  it("8. listeners and timers are released on every outcome", async () => {
    const h = harness();
    const ac = new AbortController();
    const p = h.provider.execute(baseRequest({ operationName: "echo", inputPayload: 1, signal: ac.signal, timeoutMs: 60_000 }));
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(1); // registered while running
    (await untilSpawned(h)).exit(0, "1");
    await p;
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);

    const ac2 = new AbortController();
    const p2 = harness();
    const q = p2.provider.execute(baseRequest({ signal: ac2.signal }));
    await untilSpawned(p2);
    ac2.abort();
    await q;
    expect(getEventListeners(ac2.signal, "abort")).toHaveLength(0);
  });

  it("missing docker binary is still PROVIDER_UNAVAILABLE with no termination attempt", async () => {
    const h = harness();
    const p = h.provider.execute(baseRequest({ operationName: "echo", inputPayload: 1 }));
    const child = await untilSpawned(h);
    child.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));
    const res = await p;
    expect(res.error?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(h.commands).toHaveLength(0);
    expect(h.quiescenceCalls).toHaveLength(0);
  });

  it("docker isolation flags are unchanged", async () => {
    const h = harness();
    const ac = new AbortController();
    const p = h.provider.execute(baseRequest({ signal: ac.signal }));
    await untilSpawned(h);
    ac.abort();
    await p;
    const a = h.spawned[0]!.args;
    expect(a).toEqual(expect.arrayContaining(["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges"]));
  });

  it("15. capability declarations stay conservative and legacy providers remain NONE/COOPERATIVE", () => {
    expect(new DockerExecutionProvider().cancellationModel).toBe("COOPERATIVE");
    expect(resolveProviderCancellationModel(new DockerExecutionProvider())).not.toBe("PHYSICAL");
    expect(new InProcessExecutionProvider().cancellationModel).toBe("COOPERATIVE");
    const legacy: ExecutionProvider = { name: "legacy", async execute() { return { status: "SUCCESS", durationMs: 0 }; } };
    expect(resolveProviderCancellationModel(legacy)).toBe("NONE");
  });
});

/**
 * Result classification of a CLI exit that was NOT requested by the provider. Platform independent: the child process
 * outcome is injected, so nothing depends on how Windows or Linux report a killed process. Container state evidence comes
 * from `docker inspect` (injected), read before the container is removed.
 */
describe("CLI exit classification (no provider-requested termination)", () => {
  const inspect =
    (stdout: string, exitCode = 0) =>
    (a: readonly string[]) =>
      a[0] === "inspect" ? { exitCode, stdout } : { exitCode: 0 };
  const runCmd = (h: ReturnType<typeof harness>) =>
    h.provider.execute(baseRequest({ operationName: "run_command", inputPayload: { argv: ["sh", "-c", "exit 3"] } }));
  const verbs = (h: ReturnType<typeof harness>) => h.commands.map((c) => c.args[0]);

  it("genuine non-zero command exit (container exited with the same code) stays SUCCESS exitCode 3, no verification", async () => {
    const h = harness({ command: inspect("exited 3") });
    const p = runCmd(h);
    (await untilSpawned(h)).exit(3);
    const res = await p;
    expect(res.status).toBe("SUCCESS");
    expect((res.output as { exitCode: number }).exitCode).toBe(3);
    expect(h.quiescenceCalls).toHaveLength(0);
    expect(verbs(h)).toEqual(["inspect", "rm"]); // evidence is read BEFORE the container is removed
  });

  it("Windows-style external kill: CLI exit 1 with no signal while the container is still running -> FAILED, terminated and verified", async () => {
    const h = harness({ command: inspect("running 0") });
    const p = runCmd(h);
    (await untilSpawned(h)).exit(1);
    const res = await p;
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("EXECUTION_FAILED");
    expect(res.output).toBeUndefined();
    expect(res.providerMetadata).toMatchObject({ exitClassification: "AMBIGUOUS", cliExitCode: 1, terminationVerified: true });
    expect(verbs(h)).toContain("stop"); // the live container was actively terminated
    expect(h.quiescenceCalls).toEqual(["run-1"]);
  });

  it("the same external kill with an UNVERIFIED verdict is TERMINATION_UNVERIFIED, never SUCCESS", async () => {
    const h = harness({ command: inspect("running 0"), quiescence: () => ({ status: "UNVERIFIED", reason: "container still listed" }) });
    const p = runCmd(h);
    (await untilSpawned(h)).exit(1);
    const res = await p;
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("TERMINATION_UNVERIFIED");
  });

  it("CLI code that differs from the container's own exit code is ambiguous -> FAILED, not SUCCESS", async () => {
    const h = harness({ command: inspect("exited 137") });
    const p = runCmd(h);
    (await untilSpawned(h)).exit(1);
    const res = await p;
    expect(res.status).toBe("FAILED");
    expect(res.providerMetadata).toMatchObject({ exitClassification: "AMBIGUOUS" });
    expect(res.providerMetadata?.ambiguity).toContain("differs");
  });

  it("unreadable container state (inspect fails, throws or is malformed) is ambiguous: safest result, verification still required", async () => {
    const variants: Array<[string, (a: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string } | Error]> = [
      ["non-zero", (a) => (a[0] === "inspect" ? { exitCode: 1, stderr: "No such container" } : { exitCode: 0 })],
      ["throws", (a) => (a[0] === "inspect" ? new Error("daemon down") : { exitCode: 0 })],
      ["malformed", inspect("garbage")],
    ];
    for (const [name, command] of variants) {
      const h = harness({ command });
      const p = runCmd(h);
      (await untilSpawned(h)).exit(3);
      const res = await p;
      expect(res.status, name).toBe("FAILED");
      expect(res.providerMetadata, name).toMatchObject({ exitClassification: "AMBIGUOUS" });
      expect(h.quiescenceCalls, name).toEqual(["run-1"]);

      const bad = harness({ command, quiescence: () => ({ status: "UNVERIFIED", reason: "x" }) });
      const p2 = runCmd(bad);
      (await untilSpawned(bad)).exit(3);
      expect((await p2).error?.code, name).toBe("TERMINATION_UNVERIFIED");
    }
  });

  it("exit 0 and Docker launch errors keep their handling and never invoke inspect", async () => {
    const ok = harness();
    const p = ok.provider.execute(baseRequest({ operationName: "echo", inputPayload: 1 }));
    (await untilSpawned(ok)).exit(0, "1");
    expect((await p).status).toBe("SUCCESS");
    expect(verbs(ok)).toEqual(["rm"]);

    const launch = harness();
    const p2 = runCmd(launch);
    (await untilSpawned(launch)).exit(125, "", "docker: Error response from daemon: create failed");
    const res = await p2;
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("EXECUTION_FAILED");
    expect(res.providerMetadata?.exitClassification).toBeUndefined();
    expect(verbs(launch)).not.toContain("inspect");
  });

  it("daemon-unavailable stderr keeps PROVIDER_UNAVAILABLE and does not mask it as ambiguous", async () => {
    const h = harness();
    const p = runCmd(h);
    (await untilSpawned(h)).exit(1, "", "error during connect: Cannot connect to the Docker daemon");
    const res = await p;
    expect(res.error?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(verbs(h)).not.toContain("inspect");
  });

  it("when the provider itself requested termination, a late exit code can never produce SUCCESS (timeout and abort)", async () => {
    for (const mode of ["timeout", "abort"] as const) {
      const h = harness({ command: inspect("exited 0") });
      const ac = new AbortController();
      const p = h.provider.execute(
        baseRequest({ operationName: "run_command", inputPayload: { argv: ["true"] }, signal: ac.signal, timeoutMs: mode === "timeout" ? 10 : 5_000 })
      );
      const child = await untilSpawned(h);
      child.closeOnKill = false;
      if (mode === "abort") ac.abort();
      else await new Promise((r) => setTimeout(r, 25));
      child.exit(0); // exit code arrives after the provider decided
      const res = await p;
      expect(res.status, mode).toBe(mode === "timeout" ? "TIMED_OUT" : "CANCELLED");
      expect(res.output, mode).toBeUndefined();
    }
  });
});

describe("14. WorkerRuntime never terminalises or disposes on unverified termination", () => {
  it("leaves the run RUNNING (lease to lapse -> recovery quiescence pre-pass), even when the runtime timeout also fired", async () => {
    const provider: ExecutionProvider = {
      name: "in-process",
      tenantModel: "NONE",
      cancellationModel: "COOPERATIVE",
      async execute<TInput = unknown, TOutput = unknown>(r: ExecutionRequest<TInput>): Promise<ExecutionResult<TOutput>> {
        await new Promise((res) => setTimeout(res, 40)); // runtime's own 15ms timeout fires meanwhile
        void r;
        return {
          status: "FAILED",
          error: { code: "TERMINATION_UNVERIFIED", message: "container survives" },
          durationMs: 40,
        };
      },
    };
    const clock = new SettableClock();
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    const worker = new WorkerRuntime({ workerId: "w-unverified", coordinator, clock, executionProvider: provider });
    const task = coordinator.createTask({ title: "echo", inputPayload: null });
    createAndActivateContract(store, task.taskId);
    const { run } = coordinator.createRun({ taskId: task.taskId, timeoutMs: 15 });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce(run.runId);
    expect(result.status, JSON.stringify((result as { error?: unknown }).error)).toBe("TERMINATION_UNVERIFIED");
    expect(coordinator.getRun(run.runId)!.status).toBe("RUNNING"); // not TIMED_OUT / FAILED / CANCELLED
    store.close();
  });
});
