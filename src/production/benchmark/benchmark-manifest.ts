/**
 * Emerald Agent Fabric — Benchmark Manifest Loader
 *
 * Loads, verifies, and cryptographically digests benchmark task definitions.
 * Strictly prevents gold patch or secret test leakage to the model context.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { computeCanonicalHash } from "../../domain/canonical-hash.js";
import { BenchmarkManifest, BenchmarkTask } from "./benchmark-types.js";

export class BenchmarkManifestLoader {
  private cachedManifest?: BenchmarkManifest;

  constructor(
    private readonly manifestPath: string = path.resolve(
      process.cwd(),
      "benchmarks/swebench-v01/tasks.json",
    ),
  ) {}

  /**
   * Load and cryptographically seal the benchmark tasks manifest.
   */
  public loadManifest(): BenchmarkManifest {
    if (this.cachedManifest) {
      return this.cachedManifest;
    }

    if (!fs.existsSync(this.manifestPath)) {
      throw new Error(`Benchmark manifest not found at: ${this.manifestPath}`);
    }

    const rawContent = fs.readFileSync(this.manifestPath, "utf8");
    const tasks: BenchmarkTask[] = JSON.parse(rawContent);

    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error("Invalid benchmark manifest: expected non-empty array of tasks.");
    }

    const manifestHash = computeCanonicalHash({
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        title: t.title,
        difficulty: t.difficulty,
        sourceFile: t.sourceFile,
        testFile: t.testFile,
      })),
    }).contentHash;

    this.cachedManifest = {
      manifestVersion: "0.1.0",
      manifestHash,
      createdAt: "2026-10-21T00:00:00.000Z",
      taskCount: tasks.length,
      tasks,
    };

    return this.cachedManifest;
  }

  /**
   * Constructs an untrusted prompt for the model without leaking gold patch or tests.
   */
  public buildUntrustedPromptForModel(task: BenchmarkTask): string {
    return `You are operating as an autonomous software-engineering agent within the Emerald Agent Fabric.

MISSION OBJECTIVE:
Task ID: ${task.taskId}
Title: ${task.title}
Difficulty: ${task.difficulty}

PROBLEM STATEMENT:
${task.issue}

PRIMARY SOURCE FILE:
${task.sourceFile}

AVAILABLE TOOLS:
- read_file: inspect file contents ({"path": string, "offsetLine"?: number, "limitLines"?: number})
- write_file: write repaired code ({"path": string, "content": string})
- search_code: search code patterns in workspace ({"pattern": string})
- git_status: check working tree modifications ({})
- git_diff: review working tree patch ({})

INSTRUCTIONS:
1. First inspect ${task.sourceFile} using read_file.
2. Formulate and write the clean, minimal bug repair using write_file.
3. Review git_status and git_diff to ensure no unintended modifications.
4. Signal goal completion by setting isGoalReached: true.

OUTPUT FORMAT:
Respond ONLY with a single valid JSON object:
{
  "thought": "<concise explanation of your reasoning>",
  "toolName": "<read_file | write_file | search_code | git_status | git_diff>",
  "toolInput": { <tool arguments> },
  "isGoalReached": <optional boolean, set to true when repair is complete>
}
`;
  }
}
