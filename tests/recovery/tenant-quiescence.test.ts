/**
 * ADR-0037 rollout steps 1-2: tenant-quiescence port, provider descriptors, fail-closed rule and the recovery-sweeper pre-pass.
 * Fakes stand in for the port (no Docker): the subject is that recovery rolls back, requeues and disposes ONLY runs that were
 * proven free of live tenant processes, and leaves every other run completely untouched.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { InProcessExecutionProvider } from "../../src/adapters/execution/in-process-execution-provider.js";
import { DockerExecutionProvider } from "../../src/adapters/execution/docker-execution-provider.js";
import { DockerTenantQuiescenceAdapter } from "../../src/adapters/execution/docker-tenant-quiescence-adapter.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/index.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import type { RunSnapshot } from "../../src/domain/invariants.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { resolveProviderTenantModel, type QuiescenceResult, type TenantQuiescencePort } from "../../src/ports/tenant-quiescence.port.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import { RecoverySupervisor } from "../../src/recovery/recovery-supervisor.js";
import { RecoverySweeper } from "../../src/recovery/recovery-sweeper.js";
import { sweepNeedsOperator, summarizeSweep } from "../../src/recovery/recovery-host.js";
import { runTenantQuiescencePrePass, tenantModelFromContract } from "../../src/recovery/tenant-quiescence-gate.js";
import { createAndActivateContract } from "../application/test-helpers.js";

const fakeRun = (runId: string, extra: Partial<RunSnapshot> = {}) => ({ runId, ...extra }) as RunSnapshot;

describe("provider tenant model (step 1)", () => {
  it("an undeclared provider is assumed to leave isolated processes (unknown is never 'none')", () => {
    expect(resolveProviderTenantModel({})).toBe("ISOLATED_PROCESSES");
    expect(resolveProviderTenantModel({ tenantModel: "NONE" })).toBe("NONE");
  });
  it("the in-process provider declares NONE and the docker provider declares ISOLATED_PROCESSES with a DockerTenantQuiescenceAdapter", () => {
    expect(resolveProviderTenantModel(new InProcessExecutionProvider())).toBe("NONE");
    const docker = new DockerExecutionProvider();
    expect(resolveProviderTenantModel(docker)).toBe("ISOLATED_PROCESSES");
    expect(docker.quiescence).toBeInstanceOf(DockerTenantQuiescenceAdapter);
  });
});

describe("tenantModelFromContract", () => {
  const contract = (iso: string) => ({ spec: { policy: { isolationRequirement: iso } } }) as never;
  const bound = fakeRun("r", { contractBinding: { contractId: "c", version: 1, contentHash: "h" } });
  it("IN_PROCESS isolation means no tenants; ISOLATED, a missing binding, a missing contract or a lookup failure all mean isolated", () => {
    expect(tenantModelFromContract(() => contract("IN_PROCESS"))(bound)).toBe("NONE");
    expect(tenantModelFromContract(() => contract("ISOLATED"))(bound)).toBe("ISOLATED_PROCESSES");
    expect(tenantModelFromContract(() => contract("IN_PROCESS"))(fakeRun("r"))).toBe("ISOLATED_PROCESSES");
    expect(tenantModelFromContract(() => null)(bound)).toBe("ISOLATED_PROCESSES");
    expect(() => tenantModelFromContract(() => { throw new Error("db"); })(bound)).toThrow(); // surfaced; the pre-pass holds the run
  });
});

describe("runTenantQuiescencePrePass (fail closed)", () => {
  const port = (impl: (runId: string) => Promise<QuiescenceResult>) => {
    const calls: string[] = [];
    const p: TenantQuiescencePort = { quiesceRun: (id) => (calls.push(id), impl(id)) };
    return { p, calls };
  };
  const runs = [fakeRun("none"), fakeRun("iso")];
  const modelOf = (r: RunSnapshot) => (r.runId === "none" ? ("NONE" as const) : ("ISOLATED_PROCESSES" as const));

  it("NONE runs are released without consulting the port; QUIESCENT releases an isolated run", async () => {
    const { p, calls } = port(async () => ({ status: "QUIESCENT", stopped: 2 }));
    const r = await runTenantQuiescencePrePass(runs, { tenantModelOf: modelOf, port: p });
    expect(r.held).toEqual([]);
    expect(r.quiescedRunIds).toEqual(["iso"]);
    expect(calls).toEqual(["iso"]);
  });
  it("an isolated run is held when no port is configured", async () => {
    const r = await runTenantQuiescencePrePass(runs, { tenantModelOf: modelOf });
    expect(r.held).toEqual([{ runId: "iso", reason: expect.stringMatching(/no TenantQuiescencePort/) }]);
  });
  it("UNVERIFIED, a rejection, and an undeterminable model each hold the run with a reason", async () => {
    const unv = await runTenantQuiescencePrePass(runs, { tenantModelOf: modelOf, port: port(async () => ({ status: "UNVERIFIED", reason: "docker down" })).p });
    expect(unv.held).toEqual([{ runId: "iso", reason: expect.stringMatching(/docker down/) }]);
    const thrown = await runTenantQuiescencePrePass(runs, { tenantModelOf: modelOf, port: port(async () => { throw new Error("boom"); }).p });
    expect(thrown.held).toEqual([{ runId: "iso", reason: expect.stringMatching(/boom/) }]);
    const noModel = await runTenantQuiescencePrePass(runs, { tenantModelOf: () => { throw new Error("no contract"); } });
    expect(noModel.held.map((h) => h.runId)).toEqual(["none", "iso"]);
  });
});

describe("sweeper pre-pass with real state, supervisor and coordinator (step 2)", () => {
  let tempDir: string;
  let root: string;
  let clock: SettableClock;
  let store: SqliteStateStore;
  let adapter: NodeFsWorkspaceAdapter;
  let coordinator: RunCoordinator;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emerald-tenant-")));
    root = path.join(tempDir, "workspaces");
    fs.mkdirSync(root);
    clock = new SettableClock(new Date().toISOString());
    store = new SqliteStateStore();
    adapter = new NodeFsWorkspaceAdapter({ workspaceRoot: root });
    coordinator = new RunCoordinator(store, clock, undefined, adapter);
    coordinator.registerWorker({ workerId: "w", hostname: "h", pid: 1, status: "ACTIVE", lastHeartbeatAt: clock.nowIso(), createdAt: clock.nowIso() });
  });
  afterEach(() => {
    try { store.close(); } catch { /* closed */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const isolatedPolicy = (id: string) =>
    createExecutionPolicy({ policyId: id, allowedCapabilities: ["execution.echo"], isolationRequirement: "ISOLATED", trustedInProcessOperations: [] });

  /** A RUNNING run holding a provisioned workspace. `ttlMs` decides whether its lease is expired after the clock advance. */
  async function runWithWorkspace(label: string, isolation: "IN_PROCESS" | "ISOLATED", ttlMs: number) {
    const task = coordinator.createTask({ title: "echo", inputPayload: { label } });
    createAndActivateContract(store, task.taskId, isolation === "ISOLATED" ? { policy: isolatedPolicy(`p-${label}`) } : {});
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 15000, maxOutputBytes: 1048576 });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, "w", ttlMs);
    coordinator.startRun(run.runId, "w", claim.lease.leaseId);
    const h = await adapter.provisionWorkspace(
      { workspaceId: `ws-${run.runId}`, runId: run.runId, taskId: task.taskId, maxWorkspaceBytes: 1 << 20, maxFileSizeBytes: 1 << 20 } as never,
      { runId: run.runId, leaseId: claim.lease.leaseId }
    );
    fs.writeFileSync(path.join(h.hostPath, "tenant.txt"), "tenant data");
    return { runId: run.runId, dir: h.hostPath, leaseId: claim.lease.leaseId };
  }

  const sweeper = (port?: TenantQuiescencePort) =>
    new RecoverySweeper({
      supervisor: new RecoverySupervisor({ stateStore: store, rollbackEngine: new DurableRollbackEngine(store), clock, supervisorId: "sup" }),
      coordinator,
      tenantQuiescence: { tenantModelOf: tenantModelFromContract((id, v) => coordinator.getContract(id, v)), port },
    });
  const eventCount = (runId: string) => coordinator.getEventsForRun(runId).length;

  it("an isolated crashed run is HELD untouched when tenants cannot be proven gone (no port / UNVERIFIED / throwing port)", async () => {
    const crashed = await runWithWorkspace("iso", "ISOLATED", 5000);
    clock.advanceMs(6000);
    const before = { status: coordinator.getRun(crashed.runId)!.status, events: eventCount(crashed.runId) };

    const ports: Array<[string, TenantQuiescencePort | undefined]> = [
      ["no port", undefined],
      ["UNVERIFIED", { quiesceRun: async () => ({ status: "UNVERIFIED", reason: "container still running" }) }],
      ["throwing", { quiesceRun: async () => { throw new Error("docker unreachable"); } }],
    ];
    for (const [name, port] of ports) {
      const result = await sweeper(port).sweepOnce();
      expect(result.heldForTenantsRunIds, name).toEqual([crashed.runId]);
      expect(result.needsAttention, name).toEqual([expect.objectContaining({ runId: crashed.runId, status: "TENANTS_NOT_QUIESCED" })]);
      expect(sweepNeedsOperator(result), name).toBe(true);
      expect(summarizeSweep(result).heldForTenants, name).toEqual([crashed.runId]);
      expect(coordinator.getRun(crashed.runId)!.status, name).toBe(before.status); // no rollback, no requeue
      expect(eventCount(crashed.runId), name).toBe(before.events); // no event of any kind
      expect(fs.readFileSync(path.join(crashed.dir, "tenant.txt"), "utf8"), name).toBe("tenant data"); // workspace untouched
    }
  });

  it("once quiescence is verified the held run recovers on the next sweep: requeued and its workspace discarded", async () => {
    const crashed = await runWithWorkspace("iso", "ISOLATED", 5000);
    clock.advanceMs(6000);
    expect((await sweeper().sweepOnce()).heldForTenantsRunIds).toEqual([crashed.runId]);
    expect(fs.existsSync(crashed.dir)).toBe(true);

    const asked: string[] = [];
    const port: TenantQuiescencePort = { quiesceRun: async (id) => (asked.push(id), { status: "QUIESCENT", stopped: 1 }) };
    const result = await sweeper(port).sweepOnce();

    expect(asked).toEqual([crashed.runId]);
    expect(result.heldForTenantsRunIds).toEqual([]);
    expect(coordinator.getRun(crashed.runId)!.status).toBe("QUEUED");
    expect(fs.existsSync(crashed.dir)).toBe(false);
  });

  it("a held isolated run does not block recovery of an in-process run, and a live worker's run is never queried or touched", async () => {
    const heldRun = await runWithWorkspace("iso", "ISOLATED", 5000);
    const plain = await runWithWorkspace("plain", "IN_PROCESS", 5000);
    const live = await runWithWorkspace("live", "ISOLATED", 600000); // lease still active after the advance
    clock.advanceMs(6000);
    const asked: string[] = [];
    const port: TenantQuiescencePort = { quiesceRun: async (id) => (asked.push(id), { status: "UNVERIFIED", reason: "cannot verify" }) };

    const result = await sweeper(port).sweepOnce();

    expect(result.heldForTenantsRunIds).toEqual([heldRun.runId]);
    expect(asked).toEqual([heldRun.runId]); // not `plain` (needs no proof) and not `live` (its lease is active)
    expect(coordinator.getRun(plain.runId)!.status).toBe("QUEUED"); // recovered normally
    expect(fs.existsSync(plain.dir)).toBe(false);
    expect(coordinator.getRun(heldRun.runId)!.status).toBe("RUNNING");
    expect(fs.existsSync(heldRun.dir)).toBe(true);
    expect(coordinator.getRun(live.runId)!.status).toBe("RUNNING");
    expect(fs.readFileSync(path.join(live.dir, "tenant.txt"), "utf8")).toBe("tenant data");
  });

  it("an in-process crashed run recovers exactly as before without any port configured", async () => {
    const plain = await runWithWorkspace("plain", "IN_PROCESS", 5000);
    clock.advanceMs(6000);
    const result = await sweeper().sweepOnce();
    expect(result.heldForTenantsRunIds).toEqual([]);
    expect(coordinator.getRun(plain.runId)!.status).toBe("QUEUED");
    expect(fs.existsSync(plain.dir)).toBe(false);
  });
});
