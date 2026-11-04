/**
 * Milestone 3.1A — Verified artifact export through the durable submit -> worker -> inspect path
 *
 * Drives the real CLI, durable SQLite store, WorkerRuntime, governed write_file tool and the git artifact
 * exporter. A scripted brain makes deterministic file changes. The patch and manifest must survive workspace
 * disposal; a failed export must fail the run and preserve the workspace instead of reporting success.
 *
 * Explicit limits (not proven here, by design):
 * - The scripted brain proves the plumbing and failure semantics, not model quality.
 * - The artifact records WHAT changed; it does not verify that the change is correct (no governed test run).
 * - The final run status is read from the durable run record (artifact show --db), not copied into the artifact.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkerHostConfigError,
  runWorkerHost,
  type WorkerHostOptions,
} from "../../src/application/worker-host.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../../src/ports/agent-brain.port.js";

class ScriptedBrain implements AgentBrainPort {
  private steps: ((req: AgentBrainRequest) => AgentBrainResult)[] = [];
  invocations = 0;

  queue(step: (req: AgentBrainRequest) => AgentBrainResult): this {
    this.steps.push(step);
    return this;
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    this.invocations++;
    const next = this.steps.shift();
    return next ? next(request) : { finishReason: "GOAL_REACHED" };
  }
}

const write =
  (id: string, filePath: string, content: string) =>
  (req: AgentBrainRequest): AgentBrainResult => ({
    proposal: {
      proposalId: id,
      toolName: "write_file",
      inputPayload: { path: filePath, content, overwrite: true },
      contextSnapshotHash: req.contextSnapshot.contextHash,
    },
    finishReason: "ACTION_PROPOSED",
  });

interface InspectView {
  readonly status: string;
  readonly error: { code?: string; message?: string } | null;
  readonly events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
}

function digestTree(root: string, skip: (name: string) => boolean = () => false): string {
  const hash = crypto.createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip(entry.name)) continue;
      const full = path.join(dir, entry.name);
      hash.update(path.relative(root, full));
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) hash.update(fs.readFileSync(full));
    }
  };
  walk(root);
  return hash.digest("hex");
}

const CAPS = "workspace.file.read,workspace.file.write,workspace.code.search";

describe("Milestone 3.1A — artifact export via the durable worker path", () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceRoot: string;
  let artifactRoot: string;
  let repo: string;
  let cli: EmeraldCli;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-artifact-e2e-"));
    dbPath = path.join(tempDir, "emerald.sqlite");
    workspaceRoot = path.join(tempDir, "workspace");
    artifactRoot = path.join(tempDir, "artifacts");
    repo = path.join(tempDir, "repo");
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(artifactRoot);
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "package.json"), '{"name":"demo"}\n');
    fs.writeFileSync(path.join(repo, "src", "index.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(repo, ".env"), "TOKEN=secret\n");
    cli = new EmeraldCli();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function submit(extra: string[]): Promise<string> {
    const res = await cli.run(["submit", "--db", dbPath, "--task", "Make the change", "--capabilities", CAPS, ...extra]);
    expect(res.exitCode, res.output).toBe(0);
    return JSON.parse(res.output).runId as string;
  }

  async function runWorker(brain: ScriptedBrain, overrides: Partial<WorkerHostOptions> = {}): Promise<void> {
    await runWorkerHost({
      dbPath,
      workspaceRoot,
      artifactRoot,
      once: true,
      modelProvider: "fixture",
      agentBrain: brain,
      signal: new AbortController().signal,
      log: () => {},
      ...overrides,
    });
  }

  async function inspect(runId: string): Promise<InspectView> {
    const res = await cli.run(["inspect", "--db", dbPath, "--run-id", runId]);
    expect(res.exitCode, res.output).toBe(0);
    return JSON.parse(res.output) as InspectView;
  }

  const workspaceEntries = (): string[] =>
    fs.readdirSync(workspaceRoot).filter((name) => !name.startsWith(".emerald-owner"));

  it("exports a patch and manifest for an imported repository before the workspace is disposed", async () => {
    const before = digestTree(repo);
    const runId = await submit(["--repo", repo]);
    const brain = new ScriptedBrain()
      .queue(write("w1", "src/index.js", "module.exports = 2;\n"))
      .queue(write("w2", "src/extra.js", "exports.extra = true;\n"));

    await runWorker(brain);
    const view = await inspect(runId);

    expect(view.status).toBe("COMPLETED");
    expect(workspaceEntries()).toEqual([]);
    expect(digestTree(repo)).toBe(before);

    // The audit record is on the workspace.cleaning event that precedes disposal.
    const cleaning = view.events.find((e) => e.eventType === "workspace.cleaning");
    expect(cleaning?.payload["artifactExport"]).toMatchObject({
      artifactPath: `${runId}/attempt-1`,
      changedFiles: 2,
      added: 1,
      modified: 1,
      deleted: 0,
    });
    expect(view.events.some((e) => e.eventType === "workspace.disposed")).toBe(true);

    // The CLI shows the manifest and, with --db, the run's durable status.
    const shown = await cli.run(["artifact", "show", "--artifact-root", artifactRoot, "--run-id", runId, "--db", dbPath]);
    expect(shown.exitCode, shown.output).toBe(0);
    const parsed = JSON.parse(shown.output);
    expect(parsed.runStatus).toBe("COMPLETED");
    expect(parsed.manifest.files.map((f: { path: string; status: string }) => `${f.status}:${f.path}`)).toEqual([
      "added:src/extra.js",
      "modified:src/index.js",
    ]);

    // The patch applies to the original repository content and reproduces the agent's result.
    const patchText = (await cli.run(["artifact", "show", "--artifact-root", artifactRoot, "--run-id", runId, "--patch"])).output;
    expect(patchText).toContain("+module.exports = 2;");
    const replay = path.join(tempDir, "replay");
    fs.cpSync(repo, replay, { recursive: true });
    for (const secret of [".env"]) fs.rmSync(path.join(replay, secret), { force: true });
    execFileSync(
      "git",
      ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", path.join(artifactRoot, runId, "attempt-1", "patch.diff")],
      { cwd: replay, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }
    );
    expect(fs.readFileSync(path.join(replay, "src", "index.js"), "utf8")).toBe("module.exports = 2;\n");
    expect(fs.readFileSync(path.join(replay, "src", "extra.js"), "utf8")).toBe("exports.extra = true;\n");
    // The excluded secret never entered the baseline, so it is not part of the patch.
    expect(patchText).not.toContain("TOKEN=secret");
  });

  it("preserves a file the agent created from scratch (no repository)", async () => {
    const runId = await submit([]);
    const brain = new ScriptedBrain().queue(write("w1", "add.js", "module.exports = (a, b) => a + b;\n"));

    await runWorker(brain);
    const view = await inspect(runId);

    expect(view.status).toBe("COMPLETED");
    expect(workspaceEntries()).toEqual([]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, runId, "attempt-1", "manifest.json"), "utf8")
    );
    expect(manifest.files).toMatchObject([{ path: "add.js", status: "added" }]);
    expect(fs.readFileSync(path.join(artifactRoot, runId, "attempt-1", "patch.diff"), "utf8")).toContain(
      "+module.exports = (a, b) => a + b;"
    );
  });

  it("retains the artifact when the run fails (write stagnation) and reports the failed status", async () => {
    const runId = await submit([]);
    const brain = new ScriptedBrain()
      .queue(write("w1", "stuck.txt", "same"))
      .queue(write("w2", "stuck.txt", "same"))
      .queue(write("w3", "stuck.txt", "same"))
      .queue(write("w4", "never.txt", "unreached"));

    await runWorker(brain);
    const view = await inspect(runId);

    expect(view.status).toBe("FAILED");
    expect(JSON.stringify(view.error)).toContain("3 consecutive identical successful writes of 'stuck.txt'");
    expect(workspaceEntries()).toEqual([]);

    const shown = await cli.run(["artifact", "show", "--artifact-root", artifactRoot, "--run-id", runId, "--db", dbPath]);
    expect(shown.exitCode, shown.output).toBe(0);
    const parsed = JSON.parse(shown.output);
    expect(parsed.runStatus).toBe("FAILED");
    expect(parsed.manifest.files.map((f: { path: string }) => f.path)).toEqual(["stuck.txt"]);
  });

  it("fails the run closed and PRESERVES the workspace when the export fails", async () => {
    const runId = await submit([]);
    const brain = new ScriptedBrain()
      .queue(write("w1", "work.txt", "valuable work"))
      .queue((req) => {
        // Sabotage: destroy this run's baseline, so the pre-disposal export cannot succeed.
        fs.rmSync(path.join(artifactRoot, req.runId, "attempt-1", "baseline.git"), { recursive: true, force: true });
        return { finishReason: "GOAL_REACHED" };
      });

    await runWorker(brain);
    const view = await inspect(runId);

    expect(view.status).toBe("FAILED");
    expect(view.error?.code).toBe("ARTIFACT_EXPORT_FAILED");
    // The work is not silently lost: the workspace is still on disk and was never disposed.
    expect(view.events.some((e) => e.eventType === "workspace.failed")).toBe(true);
    expect(view.events.some((e) => e.eventType === "workspace.disposed")).toBe(false);
    const preserved = workspaceEntries();
    expect(preserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(workspaceRoot, preserved[0]!, "work.txt"), "utf8")).toBe("valuable work");
    // No artifact is presented as having been produced.
    const shown = await cli.run(["artifact", "show", "--artifact-root", artifactRoot, "--run-id", runId]);
    expect(shown.exitCode).toBe(1);
    expect(shown.output).toContain("No exported artifact");
  });

  it("fails the run before the agent runs when the baseline cannot be captured", async () => {
    const runId = await submit([]);
    // A baseline already present for this attempt makes capture refuse to overwrite it.
    fs.mkdirSync(path.join(artifactRoot, runId, "attempt-1", "baseline.git"), { recursive: true });
    const brain = new ScriptedBrain().queue(write("w1", "never.txt", "x"));

    await runWorker(brain);
    const view = await inspect(runId);

    expect(view.status).toBe("FAILED");
    expect(view.error?.code).toBe("ARTIFACT_BASELINE_FAILED");
    expect(brain.invocations).toBe(0);
    expect(workspaceEntries()).toEqual([]);
  });

  it("rejects invalid artifact configuration at worker start", async () => {
    await submit([]);
    const brain = new ScriptedBrain();

    await expect(runWorker(brain, { artifactRoot: path.join(tempDir, "missing") })).rejects.toBeInstanceOf(
      WorkerHostConfigError
    );
    await expect(runWorker(brain, { workspaceRoot: undefined })).rejects.toThrow(/requires workspaceRoot/);
    await expect(runWorker(brain, { artifactRoot: workspaceRoot })).rejects.toThrow(/must not contain one another/);
    expect(brain.invocations).toBe(0);
  });

  it("artifact show rejects bad input and reports a missing artifact", async () => {
    const noRun = await cli.run(["artifact", "show", "--artifact-root", artifactRoot, "--run-id", "does-not-exist"]);
    expect(noRun.exitCode).toBe(1);
    expect(noRun.output).toContain("No artifact found");

    const badId = await cli.run(["artifact", "show", "--artifact-root", artifactRoot, "--run-id", "../escape"]);
    expect(badId.exitCode).toBe(1);

    const badAttempt = await cli.run(["artifact", "show", "--artifact-root", artifactRoot, "--run-id", "x", "--attempt", "0"]);
    expect(badAttempt.exitCode).toBe(1);

    const noRoot = await cli.run(["artifact", "show", "--artifact-root", path.join(tempDir, "nope"), "--run-id", "x"]);
    expect(noRoot.exitCode).toBe(1);
  });
});
