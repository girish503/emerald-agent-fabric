/**
 * Milestone 3.0A — Repository ingestion through the durable submit -> worker -> inspect path
 *
 * Drives the real CLI, durable SQLite store, WorkerRuntime and governed fixture agent. A host repository is
 * submitted with `--repo`; the worker copies it into the empty per-run workspace, the agent reads the COPY
 * through the governed read_file tool, and the import is audited on the workspace.ready event.
 *
 * Explicit limits (not proven here, by design):
 * - The fixture model is deterministic; this proves the plumbing and safety boundaries, not model quality.
 * - The import is a snapshot copy; the source repository is never modified, but also never synchronized.
 * - Result export (diff, patch) before workspace disposal is NOT part of this milestone.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import { SystemClock } from "../../src/ports/clock.port.js";

interface InspectView {
  readonly status: string;
  readonly error: { code?: string; message?: string } | null;
  readonly events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
}

function digestTree(root: string): string {
  const hash = crypto.createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      hash.update(path.relative(root, full));
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) hash.update(fs.readFileSync(full));
    }
  };
  walk(root);
  return hash.digest("hex");
}

describe("Milestone 3.0A — repository ingestion via the durable worker path", () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceRoot: string;
  let repo: string;
  let cli: EmeraldCli;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-repo-import-"));
    dbPath = path.join(tempDir, "emerald.sqlite");
    workspaceRoot = path.join(tempDir, "workspace");
    repo = path.join(tempDir, "repo");
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(repo, "package.json"), '{"name":"fixture-pkg-name"}');
    fs.writeFileSync(path.join(repo, "src", "index.js"), "module.exports = 42;\n");
    fs.writeFileSync(path.join(repo, ".env"), "API_TOKEN=TOPSECRET-VALUE");
    fs.writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "dependency");
    cli = new EmeraldCli();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function submit(extra: string[]): Promise<{ exitCode: number; output: string }> {
    return cli.run(["submit", "--db", dbPath, ...extra]);
  }

  async function runWorker(): Promise<void> {
    const res = await cli.run([
      "worker",
      "--db",
      dbPath,
      "--once",
      "--model-provider",
      "fixture",
      "--allow-unverified-completion",
      "--workspace-root",
      workspaceRoot,
    ]);
    expect(res.exitCode, res.output).toBe(0);
  }

  /** Entries in the workspace root other than the adapter's own root-level ownership bookkeeping. */
  function workspaceEntries(): string[] {
    return fs.readdirSync(workspaceRoot).filter((name) => !name.startsWith(".emerald-owner"));
  }

  async function inspect(runId: string): Promise<InspectView> {
    const res = await cli.run(["inspect", "--db", dbPath, "--run-id", runId]);
    expect(res.exitCode, res.output).toBe(0);
    return JSON.parse(res.output) as InspectView;
  }

  it("copies the repository into the workspace, lets the governed agent search the COPY, audits the import, and leaves the source untouched", async () => {
    const before = digestTree(repo);
    const sub = await submit(["--task", "Search workspace for pattern fixture-pkg-name", "--repo", repo]);
    expect(sub.exitCode, sub.output).toBe(0);
    const { runId } = JSON.parse(sub.output);

    await runWorker();
    const view = await inspect(runId);

    expect(view.status).toBe("COMPLETED");

    const ready = view.events.find((e) => e.eventType === "workspace.ready");
    expect(ready?.payload["repositoryImport"]).toMatchObject({
      fileCount: 2, // package.json, src/index.js
      excludedEntries: 2, // node_modules, .env
      skippedSymlinks: 0,
      oversizeSkipped: 0,
    });

    // The governed search_code tool found the pattern in the COPIED package.json.
    const completedActions = view.events.filter((e) => e.eventType === "action.completed");
    expect(completedActions.length).toBeGreaterThanOrEqual(1);
    const results = JSON.stringify(completedActions.map((e) => e.payload));
    expect(results).toContain("package.json");
    expect(results).toContain("fixture-pkg-name");

    // The workspace is disposed after the run, and the source repository is byte-for-byte unchanged.
    expect(view.events.some((e) => e.eventType === "workspace.disposed")).toBe(true);
    expect(workspaceEntries()).toEqual([]);
    expect(digestTree(repo)).toBe(before);
  });

  it("never exposes an excluded secret file to the agent or to any persisted event", async () => {
    const sub = await submit(["--task", "Search workspace for pattern API_TOKEN", "--repo", repo]);
    expect(sub.exitCode, sub.output).toBe(0);
    const { runId } = JSON.parse(sub.output);

    await runWorker();
    const view = await inspect(runId);

    // The pattern appears only in the excluded .env, so the search over the COPY finds nothing.
    expect(view.status).toBe("COMPLETED");
    expect(JSON.stringify(view)).not.toContain("TOPSECRET-VALUE");
    const matchedFiles = JSON.stringify(
      view.events.filter((e) => e.eventType === "action.completed").map((e) => e.payload)
    );
    expect(matchedFiles).not.toContain(".env");
  });

  it("fails the run closed and disposes the workspace when the source disappears before import", async () => {
    const sub = await submit(["--task", "Read package.json", "--repo", repo]);
    const { runId } = JSON.parse(sub.output);
    fs.rmSync(repo, { recursive: true, force: true });

    await runWorker();
    const view = await inspect(runId);

    expect(view.status).toBe("FAILED");
    expect(view.error?.code).toBe("REPOSITORY_IMPORT_FAILED");
    expect(view.events.some((e) => e.eventType === "workspace.failed")).toBe(true);
    expect(workspaceEntries()).toEqual([]);
  });

  it("denies the import when the mission policy has no file-read capability", async () => {
    const sub = await submit([
      "--task",
      "Search workspace for pattern emerald",
      "--repo",
      repo,
      "--capabilities",
      "workspace.code.search",
    ]);
    expect(sub.exitCode, sub.output).toBe(0);
    const { runId } = JSON.parse(sub.output);

    await runWorker();
    const view = await inspect(runId);

    expect(view.status).toBe("FAILED");
    expect(view.error?.code).toBe("REPOSITORY_IMPORT_DENIED");
    expect(workspaceEntries()).toEqual([]);
  });

  it("stores the resolved absolute repository path on the task and rejects invalid submissions up front", async () => {
    const sub = await submit(["--task", "Read package.json", "--repo", repo]);
    expect(sub.exitCode, sub.output).toBe(0);
    const { taskId } = JSON.parse(sub.output);

    const store = new SqliteStateStore({ location: dbPath });
    try {
      const task = new RunCoordinator(store, new SystemClock()).getTask(taskId);
      expect(task?.inputPayload).toEqual({ instruction: "Read package.json", repositoryPath: repo });
    } finally {
      store.close();
    }

    const missing = await submit(["--task", "x", "--repo", path.join(tempDir, "does-not-exist")]);
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain("--repo directory not found");

    const notDir = await submit(["--task", "x", "--repo", path.join(repo, "package.json")]);
    expect(notDir.exitCode).toBe(1);
    expect(notDir.output).toContain("not a directory");

    const noTask = await submit(["--operation", "sum", "--repo", repo]);
    expect(noTask.exitCode).toBe(1);
    expect(noTask.output).toContain("--repo requires --task");

    const withInput = await submit(["--task", "x", "--repo", repo, "--input", "{}"]);
    expect(withInput.exitCode).toBe(1);
    expect(withInput.output).toContain("cannot be combined with --input");
  });
});
