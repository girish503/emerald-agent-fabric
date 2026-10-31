/**
 * Worker process used by the submission-to-recovery acceptance test (bundled by esbuild into a temp file and spawned).
 * It is a thin shell around the PRODUCTION classes: SqliteStateStore (file-backed), RunCoordinator, WorkerRuntime,
 * InProcessExecutionProvider and NodeFsWorkspaceAdapter. Only the deterministic operation is test-specific.
 *
 *   --mode hang      the operation announces itself on stdout and then never returns, so the parent can kill this process
 *                    while the run is RUNNING under a live lease (the documented crash point).
 *   --mode complete  the operation returns normally and the run is driven to a terminal state. With --gate-file it first
 *                    waits (while RUNNING under its live lease) until that file exists, so the parent can act on a live attempt.
 *
 * stdout is one JSON object per line. Nothing here touches recovery or lease state except through WorkerRuntime.
 */
import * as fs from "node:fs";
import { SqliteStateStore } from "../../../src/adapters/persistence/sqlite-state-store.js";
import { InProcessExecutionProvider } from "../../../src/adapters/execution/in-process-execution-provider.js";
import { NodeFsWorkspaceAdapter } from "../../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../../src/application/worker-runtime.js";
import type { DeterministicOperation, OperationContext } from "../../../src/domain/operation.js";
import { SystemClock } from "../../../src/ports/clock.port.js";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`missing --${name}`);
  return v;
}
const emit = (rec: Record<string, unknown>): void => {
  process.stdout.write(JSON.stringify(rec) + "\n");
};

async function main(): Promise<void> {
  const dbPath = arg("db");
  const workerId = arg("worker-id");
  const mode = arg("mode");
  const leaseTtlMs = Number(arg("lease-ttl-ms"));
  const workspaceRoot = arg("workspace-root");

  const store = new SqliteStateStore({ location: dbPath });
  const clock = new SystemClock();
  const workspace = new NodeFsWorkspaceAdapter({ workspaceRoot });
  const coordinator = new RunCoordinator(store, clock, undefined, workspace);

  const sum: DeterministicOperation<readonly number[], number> = {
    name: "sum",
    async execute(input: readonly number[], ctx: OperationContext) {
      const run = coordinator.getRun(ctx.runId)!;
      emit({ event: "operation.started", workerId, runId: ctx.runId, status: run.status, leaseId: run.leaseId, attemptCount: run.attemptCount });
      if (mode === "hang") {
        await new Promise<never>(() => setInterval(() => {}, 60_000)); // never resolves; a ref'd timer keeps the process alive
      }
      const gateIdx = process.argv.indexOf("--gate-file");
      const gate = gateIdx >= 0 ? process.argv[gateIdx + 1] : undefined;
      while (gate && !fs.existsSync(gate)) await new Promise((r) => setTimeout(r, 50));
      return { output: input.reduce((a, b) => a + b, 0) };
    },
  };

  const worker = new WorkerRuntime({
    workerId,
    coordinator,
    clock,
    leaseTtlMs,
    workspacePort: workspace,
    executionProvider: new InProcessExecutionProvider([sum]),
  });
  const result = await worker.runOnce();
  emit({ event: "worker.result", workerId, result });
  store.close();
}

main().catch((err: unknown) => {
  emit({ event: "worker.error", error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
