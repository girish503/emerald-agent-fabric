/**
 * Emerald Agent Fabric — ADR-0037 Step 5: Real Docker Integration Verification
 *
 * Dedicated, opt-in integration test suite validating Docker container discovery,
 * termination, positive verification, and recovery safety against a real local Docker daemon.
 *
 * Opt-in requirement:
 * Set EMERALD_DOCKER_INTEGRATION=1 to run these tests.
 * Standard unit test runs will skip this suite entirely.
 *
 * Safety & Confinement:
 * - Uses only the pre-cached local `node:22-alpine` image without pulling from network.
 * - Minimal, inert workloads only (node setInterval, sleep); no network (--network=none).
 * - All dropped capabilities (--cap-drop=ALL, no-new-privileges).
 * - Tracks exact container IDs and names; cleanup in finally/afterEach targets ONLY test-owned IDs.
 * - Never runs broad prune or deletes unowned containers.
 */

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DockerExecutionProvider } from "../../src/adapters/execution/docker-execution-provider.js";
import {
  DockerTenantQuiescenceAdapter,
  DOCKER_TENANT_LABELS,
  SubprocessRunner,
} from "../../src/adapters/execution/docker-tenant-quiescence-adapter.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import { RecoverySupervisor } from "../../src/recovery/recovery-supervisor.js";
import { RecoverySweeper } from "../../src/recovery/recovery-sweeper.js";
import { tenantModelFromContract } from "../../src/recovery/tenant-quiescence-gate.js";
import { createAndActivateContract } from "../application/test-helpers.js";

const execFileAsync = promisify(execFile);
const runLiveDocker = process.env.EMERALD_DOCKER_INTEGRATION === "1";

describe.skipIf(!runLiveDocker)("Docker Tenant Quiescence — Live Daemon Integration (ADR-0037 Step 5)", { timeout: 45000 }, () => {
  const createdContainers = new Set<string>();
  const TEST_IMAGE = "node:22-alpine";

  beforeAll(async () => {
    // 1. Verify Docker daemon is reachable
    const availability = await DockerExecutionProvider.isAvailable();
    if (!availability.available) {
      throw new Error(`Docker daemon is not accessible: ${availability.error}`);
    }

    // 2. Verify local image exists without pulling
    try {
      const { stdout } = await execFileAsync("docker", ["images", "-q", TEST_IMAGE]);
      if (!stdout.trim()) {
        throw new Error(`Required local image '${TEST_IMAGE}' is not present in local cache`);
      }
    } catch (err: unknown) {
      throw new Error(`Failed to verify local image cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  afterEach(async () => {
    // Explicitly delete only the containers created by this test
    for (const container of createdContainers) {
      try {
        await execFileAsync("docker", ["rm", "-f", container], { timeout: 10000 });
      } catch {
        // Ignore if already deleted
      }
    }
    createdContainers.clear();
  });

  afterAll(async () => {
    for (const container of createdContainers) {
      try {
        await execFileAsync("docker", ["rm", "-f", container], { timeout: 10000 });
      } catch {
        // Ignore
      }
    }
  });

  /**
   * Helper to spawn a safe, inert, uniquely labeled test container.
   */
  async function spawnTestContainer(
    runId: string,
    prefix: string = "emerald-live-test"
  ): Promise<{ containerId: string; containerName: string }> {
    const unique = crypto.randomUUID().slice(0, 8);
    const containerName = `${prefix}-${unique}`;
    const args = [
      "run",
      "-d",
      "--name",
      containerName,
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--label",
      `${DOCKER_TENANT_LABELS.RUN_ID}=${runId}`,
      "--label",
      `${DOCKER_TENANT_LABELS.ATTEMPT}=1`,
      "--label",
      `${DOCKER_TENANT_LABELS.LEASE_ID}=lease-${unique}`,
      "--label",
      `${DOCKER_TENANT_LABELS.WORKER_ID}=worker-${unique}`,
      TEST_IMAGE,
      "node",
      "-e",
      "setInterval(() => {}, 1000)",
    ];

    const { stdout } = await execFileAsync("docker", args, { timeout: 15000 });
    const containerId = stdout.trim();
    createdContainers.add(containerId);
    createdContainers.add(containerName);
    return { containerId, containerName };
  }

  // ---------------------------------------------------------------------------
  // A. Empty discovery
  // ---------------------------------------------------------------------------
  it("Scenario A: returns QUIESCENT for an unallocated run ID with zero matching containers", async () => {
    const unallocatedRunId = `run-empty-${crypto.randomUUID()}`;
    const adapter = new DockerTenantQuiescenceAdapter();

    const result = await adapter.quiesceRun(unallocatedRunId);
    expect(result).toEqual({ status: "QUIESCENT", stopped: 0 });

    // Confirm real Docker listing is empty
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      `label=${DOCKER_TENANT_LABELS.RUN_ID}=${unallocatedRunId}`,
      "--format",
      "{{.ID}}",
    ]);
    expect(stdout.trim()).toBe("");
  });

  // ---------------------------------------------------------------------------
  // B. Running test-owned container
  // ---------------------------------------------------------------------------
  it("Scenario B: discovers running test container, terminates it, and returns QUIESCENT after verification", async () => {
    const runId = `run-b-${crypto.randomUUID()}`;
    const { containerId } = await spawnTestContainer(runId, "emerald-test-b");

    // 1. Confirm container is discovered by Docker label
    const { stdout: beforePs } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      `label=${DOCKER_TENANT_LABELS.RUN_ID}=${runId}`,
      "--format",
      "{{.ID}} {{.State}}",
    ]);
    expect(beforePs.trim()).toContain("running");
    expect(beforePs.trim()).toContain(containerId.slice(0, 12));

    // 2. Quiesce the run via DockerTenantQuiescenceAdapter
    const adapter = new DockerTenantQuiescenceAdapter();
    const result = await adapter.quiesceRun(runId);
    expect(result).toEqual({ status: "QUIESCENT", stopped: 1 });

    // 3. Confirm container is removed from Docker daemon
    const { stdout: afterPs } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      `label=${DOCKER_TENANT_LABELS.RUN_ID}=${runId}`,
      "--format",
      "{{.ID}}",
    ]);
    expect(afterPs.trim()).toBe("");
  });

  // ---------------------------------------------------------------------------
  // C. Multiple containers
  // ---------------------------------------------------------------------------
  it("Scenario C: terminates multiple containers belonging to the same run and verifies total absence", async () => {
    const runId = `run-c-${crypto.randomUUID()}`;
    await spawnTestContainer(runId, "emerald-test-c1");
    await spawnTestContainer(runId, "emerald-test-c2");

    // Verify both are listed
    const { stdout: beforePs } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      `label=${DOCKER_TENANT_LABELS.RUN_ID}=${runId}`,
      "--format",
      "{{.ID}}",
    ]);
    const lines = beforePs.trim().split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBe(2);

    const adapter = new DockerTenantQuiescenceAdapter();
    const result = await adapter.quiesceRun(runId);
    expect(result).toEqual({ status: "QUIESCENT", stopped: 2 });

    // Verify neither container exists
    const { stdout: afterPs } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      `label=${DOCKER_TENANT_LABELS.RUN_ID}=${runId}`,
      "--format",
      "{{.ID}}",
    ]);
    expect(afterPs.trim()).toBe("");
  });

  // ---------------------------------------------------------------------------
  // D. Isolation
  // ---------------------------------------------------------------------------
  it("Scenario D: cleans only target run containers, leaving unrelated test containers running", async () => {
    const targetRunId = `run-d-target-${crypto.randomUUID()}`;
    const unrelatedRunId = `run-d-unrelated-${crypto.randomUUID()}`;

    await spawnTestContainer(targetRunId, "emerald-test-target");
    const unrelated = await spawnTestContainer(unrelatedRunId, "emerald-test-unrelated");

    const adapter = new DockerTenantQuiescenceAdapter();
    const result = await adapter.quiesceRun(targetRunId);
    expect(result).toEqual({ status: "QUIESCENT", stopped: 1 });

    // Target container is removed
    const { stdout: targetCheck } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      `label=${DOCKER_TENANT_LABELS.RUN_ID}=${targetRunId}`,
      "--format",
      "{{.ID}}",
    ]);
    expect(targetCheck.trim()).toBe("");

    // Unrelated container remains running and intact
    const { stdout: unrelatedCheck } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      `label=${DOCKER_TENANT_LABELS.RUN_ID}=${unrelatedRunId}`,
      "--format",
      "{{.ID}} {{.State}}",
    ]);
    expect(unrelatedCheck.trim()).toContain("running");
    expect(unrelatedCheck.trim()).toContain(unrelated.containerId.slice(0, 12));
  });

  // ---------------------------------------------------------------------------
  // E. Docker failure simulation without altering daemon state
  // ---------------------------------------------------------------------------
  it("Scenario E: returns UNVERIFIED on simulated command failure without changing daemon state", async () => {
    const runner: SubprocessRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Error response from daemon: simulated daemon timeout or error",
    });

    const failingAdapter = new DockerTenantQuiescenceAdapter({ runner });
    const result = await failingAdapter.quiesceRun("run-simulated-failure");

    expect(result.status).toBe("UNVERIFIED");
    if (result.status === "UNVERIFIED") {
      expect(result.reason).toContain("simulated daemon timeout or error");
    }
  });

  // ---------------------------------------------------------------------------
  // F. Recovery safety integration
  // ---------------------------------------------------------------------------
  it("Scenario F: Recovery holds an isolated run without rollback or workspace disposal when quiescence is UNVERIFIED", async () => {
    const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emerald-live-rec-")));
    const root = path.join(tempDir, "workspaces");
    fs.mkdirSync(root);
    const clock = new SettableClock(new Date().toISOString());
    const store = new SqliteStateStore();
    const adapter = new NodeFsWorkspaceAdapter({ workspaceRoot: root });
    const coordinator = new RunCoordinator(store, clock, undefined, adapter);
    coordinator.registerWorker({
      workerId: "w-live",
      hostname: "host-live",
      pid: 200,
      status: "ACTIVE",
      lastHeartbeatAt: clock.nowIso(),
      createdAt: clock.nowIso(),
    });

    try {
      const isolatedPolicy = createExecutionPolicy({
        policyId: "p-rec-live",
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
        trustedInProcessOperations: [],
      });

      const task = coordinator.createTask({ title: "echo", inputPayload: {} });
      createAndActivateContract(store, task.taskId, { policy: isolatedPolicy });
      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 15000 });
      coordinator.queueRun(run.runId);
      const claim = coordinator.claimRun(run.runId, "w-live", 5000);
      coordinator.startRun(run.runId, "w-live", claim.lease.leaseId);

      const h = await adapter.provisionWorkspace(
        { workspaceId: `ws-${run.runId}`, runId: run.runId, taskId: task.taskId, maxWorkspaceBytes: 1 << 20, maxFileSizeBytes: 1 << 20 } as never,
        { runId: run.runId, leaseId: claim.lease.leaseId }
      );
      const canaryFile = path.join(h.hostPath, "canary.txt");
      fs.writeFileSync(canaryFile, "live recovery canary data");

      // Advance clock past lease TTL
      clock.advanceMs(6000);

      // Quiescence port returning UNVERIFIED (e.g. surviving container)
      const unverifiedPort = {
        quiesceRun: async () => ({
          status: "UNVERIFIED" as const,
          reason: "live integration: container termination pending",
        }),
      };

      const sweeper = new RecoverySweeper({
        supervisor: new RecoverySupervisor({
          stateStore: store,
          rollbackEngine: new DurableRollbackEngine(store),
          clock,
          supervisorId: "sup-live-rec",
        }),
        coordinator,
        tenantQuiescence: {
          tenantModelOf: tenantModelFromContract((id, v) => coordinator.getContract(id, v)),
          port: unverifiedPort,
        },
      });

      const sweepResult = await sweeper.sweepOnce();
      expect(sweepResult.heldForTenantsRunIds).toEqual([run.runId]);
      expect(sweepResult.needsAttention).toEqual([
        expect.objectContaining({ runId: run.runId, status: "TENANTS_NOT_QUIESCED" }),
      ]);

      // Workspace directory and file MUST remain untouched
      expect(coordinator.getRun(run.runId)!.status).toBe("RUNNING");
      expect(fs.existsSync(canaryFile)).toBe(true);
      expect(fs.readFileSync(canaryFile, "utf8")).toBe("live recovery canary data");
    } finally {
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
