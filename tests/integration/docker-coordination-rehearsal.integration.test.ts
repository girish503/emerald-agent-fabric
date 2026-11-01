/**
 * Emerald Agent Fabric — ADR-0038 Controlled Docker Rehearsal
 *
 * Tightly scoped local-only integration rehearsal combining the real Docker daemon
 * with the file-backed SQLite launch coordinator and recovery quiescence gate.
 *
 * Opt-in requirement: Set EMERALD_DOCKER_INTEGRATION=1 to run these tests.
 */
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteTenantLaunchCoordinator } from "../../src/adapters/coordination/sqlite-tenant-launch-coordinator.js";
import { DockerExecutionProvider } from "../../src/adapters/execution/docker-execution-provider.js";
import {
  DockerTenantQuiescenceAdapter,
  DOCKER_TENANT_LABELS,
  SubprocessRunner,
} from "../../src/adapters/execution/docker-tenant-quiescence-adapter.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { runTenantQuiescencePrePass } from "../../src/recovery/tenant-quiescence-gate.js";
import { createAndActivateContract } from "../application/test-helpers.js";

const execFileAsync = promisify(execFile);
const runLiveDocker = process.env.EMERALD_DOCKER_INTEGRATION === "1";

describe.skipIf(!runLiveDocker)(
  "ADR-0038 Controlled Docker Rehearsal (Real Daemon & SQLite Coordination)",
  { timeout: 60000 },
  () => {
    const TEST_IMAGE = "node:22-alpine";
    const createdContainers = new Set<string>();

    let testRoot: string;
    let dbPath: string;
    let workspaceRoot: string;
    let store: SqliteStateStore;
    let clock: SettableClock;
    let workspaceAdapter: NodeFsWorkspaceAdapter;
    let coordinator: RunCoordinator;
    let launchCoordinator: SqliteTenantLaunchCoordinator;

    beforeAll(async () => {
      // 1. Verify Docker daemon is reachable
      const availability = await DockerExecutionProvider.isAvailable();
      if (!availability.available) {
        throw new Error(`Docker daemon is not accessible: ${availability.error}`);
      }

      // 2. Verify local image exists without pulling
      const { stdout } = await execFileAsync("docker", ["images", "-q", TEST_IMAGE]);
      if (!stdout.trim()) {
        throw new Error(`Required local image '${TEST_IMAGE}' is not present in local cache`);
      }
    });

    beforeEach(async () => {
      testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emerald-rehearsal-")));
      dbPath = path.join(testRoot, "fabric.db");
      workspaceRoot = path.join(testRoot, "workspaces");
      fs.mkdirSync(workspaceRoot, { recursive: true });

      store = new SqliteStateStore({ location: dbPath });
      clock = new SettableClock();
      workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot });
      coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);
      launchCoordinator = new SqliteTenantLaunchCoordinator(store, clock, { pollIntervalMs: 25 });
    });

    afterEach(async () => {
      // Unconditionally remove only test-owned containers created during rehearsal
      for (const container of createdContainers) {
        try {
          await execFileAsync("docker", ["rm", "-f", container], { timeout: 10000 });
        } catch {}
      }
      createdContainers.clear();

      store.close();
      try {
        fs.rmSync(testRoot, { recursive: true, force: true });
      } catch {}
    });

    afterAll(async () => {
      for (const container of createdContainers) {
        try {
          await execFileAsync("docker", ["rm", "-f", container], { timeout: 10000 });
        } catch {}
      }
    });

    function createTestRun(title: string = "slow"): string {
      const task = coordinator.createTask({ title, inputPayload: {} });
      const policy = createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: [`execution.${title}`, "execution.slow", "execution.echo"],
        isolationRequirement: "ISOLATED",
        trustedInProcessOperations: [],
      });
      createAndActivateContract(store, task.taskId, { policy });
      const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 30000 });
      coordinator.queueRun(run.runId);
      return run.runId;
    }

    async function spawnRawTestContainer(
      runId: string,
      prefix: string = "emerald-rehearsal"
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

    // -------------------------------------------------------------------------
    // Scenario 1: Worker holds gate during execution
    // -------------------------------------------------------------------------
    it("Scenario 1: Worker holds gate during execution; competing recovery fails closed and preserves workspace", async () => {
      const workerId = `w-rehearsal-${crypto.randomUUID().slice(0, 8)}`;
      coordinator.registerWorker({
        workerId,
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: clock.nowIso(),
        createdAt: clock.nowIso(),
      });

      const runId = createTestRun("slow");

      const dockerProvider = new DockerExecutionProvider({
        image: TEST_IMAGE,
        networkDisabled: true,
      });

      const workerRuntime = new WorkerRuntime({
        workerId,
        coordinator,
        clock,
        workspacePort: workspaceAdapter,
        executionProvider: dockerProvider,
        launchCoordinator,
        leaseTtlMs: 30000,
      });

      // Start the worker running the "slow" container operation in the background
      const runPromise = workerRuntime.runOnce();

      // Poll until container is running in Docker daemon
      let containerId: string | null = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const { stdout } = await execFileAsync("docker", [
          "ps",
          "-q",
          "--filter",
          `label=${DOCKER_TENANT_LABELS.RUN_ID}=${runId}`,
        ]);
        if (stdout.trim()) {
          const firstId = stdout.trim().split(/\r?\n/)[0];
          if (firstId) {
            containerId = firstId;
            createdContainers.add(containerId);
            break;
          }
        }
      }
      expect(containerId).not.toBeNull();

      // Write a canary file into the provisioned workspace
      const wsDir = path.join(workspaceRoot, `ws-${runId}`);
      const canaryFile = path.join(wsDir, "canary.txt");
      fs.writeFileSync(canaryFile, "scenario-1-original-work-must-survive", "utf8");

      // 1. Confirm worker holds the gate in SQLite while container is running
      const gate = store.getTenantLaunchGate(runId);
      expect(gate).not.toBeNull();
      expect(gate?.state).toBe("ACQUIRED");
      expect(gate?.holderType).toBe("WORKER");
      expect(gate?.holderId).toBe(workerId);
      expect(gate?.ownerPid).toBe(process.pid);

      // 2. Trigger competing recovery pre-pass
      const quiescenceAdapter = new DockerTenantQuiescenceAdapter();
      const currentRunSnapshot = coordinator.getRun(runId)!;
      const prePass = await runTenantQuiescencePrePass([currentRunSnapshot], {
        launchCoordinator,
        port: quiescenceAdapter,
        supervisorId: "supervisor-rehearsal",
        supervisorPid: 999999,
        tenantModelOf: () => "ISOLATED_PROCESSES",
      });

      // 3. Verify recovery CANNOT reclaim gate from live worker
      expect(prePass.heldRunIds.has(runId)).toBe(true);
      expect(prePass.held[0]!.reason).toMatch(
        /is currently held by WORKER|still alive; tenant launch gate stealing refused/
      );

      // 4. Confirm workspace canary file remains completely untouched
      expect(fs.existsSync(canaryFile)).toBe(true);
      expect(fs.readFileSync(canaryFile, "utf8")).toBe("scenario-1-original-work-must-survive");

      // 5. Terminate container to allow worker run to exit cleanly
      if (containerId) {
        await execFileAsync("docker", ["kill", containerId]);
      }
      await runPromise.catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
    });

    // -------------------------------------------------------------------------
    // Scenario 2: Recovery after worker termination
    // -------------------------------------------------------------------------
    it("Scenario 2: Recovery identifies and terminates container after worker process termination", async () => {
      const runId = createTestRun("slow");
      const deadWorkerId = `w-dead-${crypto.randomUUID().slice(0, 8)}`;

      // 1. Start a live test container with this runId
      await spawnRawTestContainer(runId, "emerald-rehearsal-dead");

      // Verify container is running in Docker daemon
      const { stdout: psBefore } = await execFileAsync("docker", [
        "ps",
        "--filter",
        `label=${DOCKER_TENANT_LABELS.RUN_ID}=${runId}`,
        "--format",
        "{{.ID}} {{.State}}",
      ]);
      expect(psBefore.trim()).toContain("running");

      // 2. Insert gate in SQLite owned by dead worker PID
      const deadPid = 2_147_483_647; // non-existent PID guaranteed dead
      store.acquireTenantLaunchGate({
        runId,
        holderType: "WORKER",
        holderId: deadWorkerId,
        leaseId: "lease-dead",
        ownerPid: deadPid,
        ttlMs: 500,
        nowIso: clock.nowIso(),
      });

      // 3. Advance clock past nominal gate TTL
      clock.advanceMs(1000);

      // 4. Run recovery pre-pass with actual DockerTenantQuiescenceAdapter
      const quiescenceAdapter = new DockerTenantQuiescenceAdapter();
      const runSnapshot = coordinator.getRun(runId)!;
      const prePass = await runTenantQuiescencePrePass([runSnapshot], {
        launchCoordinator,
        port: quiescenceAdapter,
        supervisorId: "supervisor-rehearsal-2",
        supervisorPid: process.pid,
        tenantModelOf: () => "ISOLATED_PROCESSES",
      });

      // 5. Verify recovery successfully reclaimed gate and quiesced the container
      expect(prePass.quiescedRunIds).toContain(runId);
      expect(prePass.heldRunIds.has(runId)).toBe(false);

      // 6. Verify container was positively terminated and removed from Docker daemon
      const { stdout: psAfter } = await execFileAsync("docker", [
        "ps",
        "-a",
        "--filter",
        `label=${DOCKER_TENANT_LABELS.RUN_ID}=${runId}`,
        "--format",
        "{{.ID}}",
      ]);
      expect(psAfter.trim()).toBe("");

      // 7. Verify gate in SQLite is now held by recovery supervisor
      const gateAfter = store.getTenantLaunchGate(runId);
      expect(gateAfter?.holderType).toBe("RECOVERY");
      expect(gateAfter?.holderId).toBe("supervisor-rehearsal-2");
    });

    // -------------------------------------------------------------------------
    // Scenario 3: Fail-closed daemon error via test seam
    // -------------------------------------------------------------------------
    it("Scenario 3: Returns UNVERIFIED on injected daemon error; workspace and run remain held", async () => {
      const runId = createTestRun("slow");

      // Simulate a Docker daemon timeout error through the injected SubprocessRunner seam
      const failingRunner: SubprocessRunner = async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Error response from daemon: simulated daemon timeout or error",
      });

      const failingAdapter = new DockerTenantQuiescenceAdapter({ runner: failingRunner });
      const result = await failingAdapter.quiesceRun(runId);

      expect(result.status).toBe("UNVERIFIED");
      expect((result as any).reason).toContain("simulated daemon timeout or error");

      // Verify recovery pre-pass marks run HELD
      const runSnapshot = coordinator.getRun(runId)!;
      const prePass = await runTenantQuiescencePrePass([runSnapshot], {
        launchCoordinator,
        port: failingAdapter,
        supervisorId: "supervisor-rehearsal-3",
        tenantModelOf: () => "ISOLATED_PROCESSES",
      });

      expect(prePass.heldRunIds.has(runId)).toBe(true);
      expect(prePass.quiescedRunIds).not.toContain(runId);
      expect(prePass.held[0]!.reason).toContain("simulated daemon timeout or error");
    });

    // -------------------------------------------------------------------------
    // Scenario 4: Label-scoped cleanup verification
    // -------------------------------------------------------------------------
    it("Scenario 4: Confirms no rehearsal containers remain and preserves unrelated containers", async () => {
      const unrelatedRunId = `run-unrelated-keep-${crypto.randomUUID().slice(0, 8)}`;
      const rehearsalRunId = `run-rehearsal-clean-${crypto.randomUUID().slice(0, 8)}`;

      // Spawn an unrelated container and a rehearsal container
      const unrelated = await spawnRawTestContainer(unrelatedRunId, "emerald-unrelated");
      const rehearsal = await spawnRawTestContainer(rehearsalRunId, "emerald-clean");

      const quiescenceAdapter = new DockerTenantQuiescenceAdapter();

      // Clean ONLY the rehearsal container via adapter
      const result = await quiescenceAdapter.quiesceRun(rehearsalRunId);
      expect(result).toEqual({ status: "QUIESCENT", stopped: 1 });

      // Rehearsal container is gone
      const { stdout: psRehearsal } = await execFileAsync("docker", [
        "ps",
        "-a",
        "--filter",
        `label=${DOCKER_TENANT_LABELS.RUN_ID}=${rehearsalRunId}`,
        "--format",
        "{{.ID}}",
      ]);
      expect(psRehearsal.trim()).toBe("");

      // Unrelated container is untouched and still running
      const { stdout: psUnrelated } = await execFileAsync("docker", [
        "ps",
        "--filter",
        `label=${DOCKER_TENANT_LABELS.RUN_ID}=${unrelatedRunId}`,
        "--format",
        "{{.ID}}",
      ]);
      expect(psUnrelated.trim()).toContain(unrelated.containerId.slice(0, 12));

      // Clean up the unrelated container cleanly
      await execFileAsync("docker", ["rm", "-f", unrelated.containerId]);
      createdContainers.delete(unrelated.containerId);
      createdContainers.delete(rehearsal.containerId);
    });
  }
);
