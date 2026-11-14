/**
 * HumanEval Benchmark Runner for Emerald Agent Fabric.
 *
 * Executes reproducible benchmarks against the 10-task HumanEval subset:
 * 1. Zero Cloud / ₹0 Cost: Runs strictly against local Ollama (qwen2.5-coder:1.5b).
 * 2. Full Governance: All model outputs transit typed proposal validation, capability fencing,
 *    and independent verification.
 * 3. Physical Test Execution: Evaluates solutions by running test_solution.py via python.
 * 4. Honest Accounting: Records exact outcomes (PASSED, FAILED, TIMED_OUT), turns taken,
 *    tools called, patch size, and duration without cherry-picking.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { SqliteStateStore } from "../../adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../adapters/workspace/node-fs-workspace-adapter.js";
import { SystemClock } from "../../ports/clock.port.js";
import { RunCoordinator } from "../run-coordinator.js";
import { WorkerRuntime } from "../worker-runtime.js";
import { GovernedAgentExecutionProvider } from "../../adapters/execution/governed-agent-execution-provider.js";
import { OllamaModelProvider } from "../../adapters/models/ollama-model-provider.js";
import { LiveAgentBrain } from "../live-agent-brain.js";
import { AgentStepController } from "../agent-step-controller.js";
import { CleanRoomVerifier } from "../clean-room-verifier.js";
import { createExecutionPolicy } from "../../domain/policy.js";
import {
  createMissionContract,
  createResourceLimits,
} from "../../domain/mission-contract.js";

const execFileAsync = promisify(child_process.execFile);

export interface HumanEvalTaskRecord {
  readonly task_id: string;
  readonly prompt: string;
  readonly entry_point: string;
  readonly canonical_solution: string;
  readonly test: string;
}

export interface HumanEvalBenchmarkResult {
  readonly taskId: string;
  readonly entryPoint: string;
  readonly status: "PASSED" | "FAILED" | "TIMED_OUT";
  readonly durationMs: number;
  readonly turnsTaken: number;
  readonly turnDurationsMs?: readonly number[];
  readonly toolsCalled: readonly string[];
  readonly patchSizeBytes: number;
  readonly patchDiff?: string;
  readonly terminalReason?: string;
  readonly terminalMessage?: string;
  readonly testPassed: boolean;
  readonly testOutput?: string;
  readonly failureReason?: string;
}

export interface HumanEvalRunOptions {
  readonly tasksFile?: string;
  readonly model?: string;
  readonly ollamaBaseUrl?: string;
  readonly taskTimeoutMs?: number;
  readonly modelTimeoutMs?: number;
  readonly limit?: number;
  readonly onProgress?: (result: HumanEvalBenchmarkResult, index: number, total: number) => void;
}

export async function runHumanEvalBenchmark(
  options: HumanEvalRunOptions = {}
): Promise<{
  readonly totalTasks: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly timedOutCount: number;
  readonly passRate: number;
  readonly totalDurationMs: number;
  readonly results: readonly HumanEvalBenchmarkResult[];
}> {
  const model = options.model ?? "qwen2.5-coder:1.5b";
  const ollamaBaseUrl = options.ollamaBaseUrl ?? (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434");
  const taskTimeoutMs = options.taskTimeoutMs ?? 180_000;
  const modelTimeoutMs = options.modelTimeoutMs ?? 120_000;

  const repoRoot = process.cwd();
  const tasksFilePath = options.tasksFile ?? path.join(repoRoot, "benchmarks", "humaneval", "10-tasks.json");

  if (!fs.existsSync(tasksFilePath)) {
    throw new Error(`Tasks manifest file not found: ${tasksFilePath}`);
  }

  const manifestContent = fs.readFileSync(tasksFilePath, "utf8");
  const manifest = JSON.parse(manifestContent) as {
    dataset: string;
    tasks: HumanEvalTaskRecord[];
  };

  const allTasks = options.limit ? manifest.tasks.slice(0, options.limit) : manifest.tasks;
  const results: HumanEvalBenchmarkResult[] = [];
  const overallStart = Date.now();

  for (let idx = 0; idx < allTasks.length; idx++) {
    const task = allTasks[idx]!;
    const taskStart = Date.now();
    const runTempDir = fs.mkdtempSync(path.join(os.tmpdir(), `emerald-humaneval-${task.entry_point}-`));

    const dbPath = path.join(runTempDir, "state.db");
    const workspaceRoot = path.join(runTempDir, "workspaces");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    let store: SqliteStateStore | undefined;
    let wsHandle: any = null;

    try {
      const clock = new SystemClock();
      store = new SqliteStateStore({ location: dbPath });
      const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot });
      const coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);
      const executionProvider = new GovernedAgentExecutionProvider({ clock });

      const workerId = `worker-humaneval-${idx + 1}`;
      const workerRuntime = new WorkerRuntime({
        workerId,
        hostname: "localhost",
        pid: process.pid,
        coordinator,
        clock,
        workspacePort: workspaceAdapter,
        executionProvider,
        isIsolationAvailable: true,
      });

      const cleanRoomVerifier = new CleanRoomVerifier({
        workspacePort: workspaceAdapter,
        workerRuntime,
        coordinator,
        stateStore: store,
        clock,
      });

      const ollama = new OllamaModelProvider({
        baseURL: ollamaBaseUrl,
        defaultModel: model,
        timeoutMs: modelTimeoutMs,
      });

      const brain = new LiveAgentBrain({
        modelProvider: ollama,
        model,
        timeoutMs: modelTimeoutMs,
        clock,
      });

      const stepController = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        cleanRoomVerifier,
        clock,
      });

      // Provision workspace
      const workspaceId = `ws-humaneval-${idx + 1}`;
      const taskId = `task-humaneval-${idx + 1}`;
      const runId = `run-humaneval-${idx + 1}`;

      wsHandle = await workspaceAdapter.provisionWorkspace({
        workspaceId,
        runId,
        taskId,
        maxWorkspaceBytes: 50 * 1024 * 1024,
        maxFileSizeBytes: 5 * 1024 * 1024,
      });

      // Populate solution.py stub and test_solution.py
      const initialSolution = `${task.prompt}    pass\n`;
      const testContent = [
        `from solution import ${task.entry_point}`,
        ``,
        task.test,
        ``,
        `if __name__ == '__main__':`,
        `    check(${task.entry_point})`,
        `    print("PASS: all test assertions passed")`,
      ].join("\n");

      fs.writeFileSync(path.join(wsHandle.hostPath, "solution.py"), initialSolution, "utf8");
      fs.writeFileSync(path.join(wsHandle.hostPath, "test_solution.py"), testContent, "utf8");

      // Initialize git
      await execFileAsync("git", ["init"], { cwd: wsHandle.hostPath });
      await execFileAsync("git", ["config", "user.name", "Emerald HumanEval Agent"], { cwd: wsHandle.hostPath });
      await execFileAsync("git", ["config", "user.email", "agent@emerald.fabric"], { cwd: wsHandle.hostPath });
      await execFileAsync("git", ["add", "."], { cwd: wsHandle.hostPath });
      await execFileAsync("git", ["commit", "-m", "Initial stub and tests"], { cwd: wsHandle.hostPath });

      const taskDescription = [
        `Task: Implement Python function '${task.entry_point}' in 'solution.py'`,
        `Inspect 'solution.py' and 'test_solution.py'.`,
        `Complete the implementation of '${task.entry_point}' in 'solution.py' so that all tests pass.`,
        `Verify with: python test_solution.py`,
      ].join("\n");

      coordinator.createTask({
        taskId,
        title: "echo",
        description: taskDescription,
        inputPayload: { entryPoint: task.entry_point, file: "solution.py" },
      });

      const policy = createExecutionPolicy({
        policyId: `policy-humaneval-${idx + 1}`,
        allowedCapabilities: [
          "execution.echo",
          "workspace.file.read",
          "workspace.file.write",
          "workspace.code.search",
          "process.execute",
          "read_file",
          "write_file",
          "edit_file",
          "run_command",
          "search_code",
          "git_status",
          "git_diff",
        ],
        trustedInProcessOperations: ["echo"],
        isolationRequirement: "IN_PROCESS",
        tenantId: "tenant-humaneval",
      });

      const contract = createMissionContract({
        contractId: `contract-humaneval-${idx + 1}`,
        version: 1,
        taskId,
        policy,
        resourceLimits: createResourceLimits({
          timeoutMs: taskTimeoutMs,
          maxAttempts: 3,
          maxOutputBytes: 10 * 1024 * 1024,
        }),
      });

      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, 1);

      coordinator.registerWorker({
        workerId,
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: clock.now().toISOString(),
        createdAt: clock.now().toISOString(),
      });

      const { run } = coordinator.createRun({ taskId });
      coordinator.queueRun(run.runId);
      // Give lease generous TTL so it does not expire during model inference
      const leaseTtlMs = Math.max(600_000, taskTimeoutMs + 300_000);
      const claim = coordinator.claimRun(run.runId, workerId, leaseTtlMs);
      coordinator.startRun(run.runId, workerId, claim.lease.leaseId);

      const stepResult = await stepController.runStepLoop({
        runId: run.runId,
        workerId,
        leaseId: claim.lease.leaseId,
        workspace: wsHandle,
        budget: {
          maxSteps: 8,
          maxActions: 12,
          maxWallClockMs: taskTimeoutMs,
          maxConsecutiveFailures: 3,
          maxProposalRejections: 3,
        },
      });

      const durationMs = Date.now() - taskStart;

      // Inspect recorded actions
      const actions = store.getActionsForRun(run.runId);
      const toolsCalled = actions.map((a) => a.toolName);
      const turnsTaken = actions.length;
      const turnDurationsMs = stepResult.transcript.map((e) => e.durationMs);

      // Extract generated git diff
      let patchDiff = "";
      try {
        const { stdout: diffOut } = await execFileAsync("git", ["diff", "solution.py"], {
          cwd: wsHandle.hostPath,
        });
        patchDiff = diffOut.trim();
      } catch {
        patchDiff = "";
      }
      const patchSizeBytes = Buffer.byteLength(patchDiff, "utf8");

      // Physical test execution
      let testPassed = false;
      let testOutput = "";
      try {
        const { stdout, stderr } = await execFileAsync("python", ["test_solution.py"], {
          cwd: wsHandle.hostPath,
          timeout: 15_000,
        });
        testOutput = `${stdout}\n${stderr}`.trim();
        testPassed = testOutput.includes("PASS: all test assertions passed");
      } catch (testErr: any) {
        testOutput = (testErr.stdout || "") + "\n" + (testErr.stderr || testErr.message || "");
        testOutput = testOutput.trim();
      }

      let status: "PASSED" | "FAILED" | "TIMED_OUT" = "FAILED";
      let failureReason: string | undefined;

      if (testPassed) {
        status = "PASSED";
      } else if (
        stepResult.terminalReason === "MAX_WALL_CLOCK" ||
        durationMs >= taskTimeoutMs ||
        stepResult.terminalMessage?.includes("timed out")
      ) {
        status = "TIMED_OUT";
        failureReason = `Timeout exhausted (${durationMs}ms): ${stepResult.terminalMessage || stepResult.terminalReason}`;
      } else if (patchSizeBytes === 0) {
        status = "FAILED";
        failureReason = `EMPTY_PATCH: Model did not produce code modifications (actions: ${turnsTaken})`;
      } else {
        status = "FAILED";
        failureReason = `ASSERTION_FAILURE: Tests failed after model modification`;
      }

      const benchmarkResult: HumanEvalBenchmarkResult = {
        taskId: task.task_id,
        entryPoint: task.entry_point,
        status,
        durationMs,
        turnsTaken,
        turnDurationsMs,
        toolsCalled,
        patchSizeBytes,
        patchDiff: patchSizeBytes > 0 ? patchDiff : undefined,
        terminalReason: stepResult.terminalReason,
        terminalMessage: stepResult.terminalMessage,
        testPassed,
        testOutput: testOutput.slice(0, 500),
        failureReason,
      };

      results.push(benchmarkResult);
      if (options.onProgress) {
        options.onProgress(benchmarkResult, idx + 1, allTasks.length);
      }
    } catch (err: any) {
      const durationMs = Date.now() - taskStart;
      const benchmarkResult: HumanEvalBenchmarkResult = {
        taskId: task.task_id,
        entryPoint: task.entry_point,
        status: "FAILED",
        durationMs,
        turnsTaken: 0,
        toolsCalled: [],
        patchSizeBytes: 0,
        testPassed: false,
        failureReason: `Harness error: ${err.message}`,
      };
      results.push(benchmarkResult);
      if (options.onProgress) {
        options.onProgress(benchmarkResult, idx + 1, allTasks.length);
      }
    } finally {
      if (store) {
        try {
          store.close();
        } catch {}
      }
      try {
        fs.rmSync(runTempDir, { recursive: true, force: true });
      } catch {}
    }
  }

  const passedCount = results.filter((r) => r.status === "PASSED").length;
  const timedOutCount = results.filter((r) => r.status === "TIMED_OUT").length;
  const failedCount = results.filter((r) => r.status === "FAILED").length;
  const totalTasks = results.length;
  const passRate = totalTasks > 0 ? Math.round((passedCount / totalTasks) * 100) : 0;
  const totalDurationMs = Date.now() - overallStart;

  // Persist results
  const resultsOutPath = path.join(repoRoot, "benchmarks", "humaneval", "benchmark-results.json");
  try {
    fs.writeFileSync(
      resultsOutPath,
      JSON.stringify(
        {
          dataset: "HumanEval",
          model,
          evaluatedAt: new Date().toISOString(),
          budgetPerTaskSec: Math.round(taskTimeoutMs / 1000),
          totalTasks,
          passedCount,
          failedCount,
          timedOutCount,
          passRatePercent: passRate,
          totalDurationMs,
          results,
        },
        null,
        2
      ),
      "utf8"
    );
  } catch {}

  return {
    totalTasks,
    passedCount,
    failedCount,
    timedOutCount,
    passRate,
    totalDurationMs,
    results,
  };
}
