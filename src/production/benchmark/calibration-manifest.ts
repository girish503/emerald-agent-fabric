/**
 * Emerald Agent Fabric — Production V1.5: Calibration Manifest Loader
 *
 * Loads, verifies, and manages the 5-task calibration suite.
 * Strictly prevents gold patch or secret test leakage into model prompts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { computeCanonicalHash } from "../../domain/canonical-hash.js";
import { BenchmarkManifest, BenchmarkTask } from "./benchmark-types.js";

export const ANCHORED_EDIT_DEMONSTRATION_VERSION = "v1.7.0";

export const ANCHORED_EDIT_DEMONSTRATION_FRAGMENT = `
EXAMPLE OF SURGICAL LINE-ANCHORED EDITING (edit_file_anchor):
Suppose an existing file "config.js" has:
\`\`\`javascript
const SERVICE_NAME = "analytics";
const TIMEOUT_MS = 1000;
module.exports = { SERVICE_NAME, TIMEOUT_MS };
\`\`\`
To fix a bug where TIMEOUT_MS should be 5000, do NOT rewrite the whole file with write_file.
Instead, use edit_file_anchor to replace ONLY the unique target line:
\`\`\`json
{
  "thought": "Update TIMEOUT_MS to 5000 using edit_file_anchor to preserve surrounding exports.",
  "toolName": "edit_file_anchor",
  "toolInput": {
    "path": "config.js",
    "searchAnchor": "const TIMEOUT_MS = 1000;",
    "replacementText": "const TIMEOUT_MS = 5000;"
  }
}
\`\`\`
Successful Tool Response:
\`\`\`json
{
  "path": "config.js",
  "occurrences": 1,
  "replacedCount": 1,
  "applied": true
}
\`\`\`
RULES FOR ANCHORED EDITING:
- Prefer edit_file_anchor for localized changes to existing files so exports, comments, and unaffected code are preserved byte-for-byte.
- Use write_file only when creating a brand new file or when complete replacement is specifically intended.
- If searchAnchor is not found or ambiguous, refine the searchAnchor with more context lines; never fall back to overwriting the whole file.`;

export function getAnchoredEditDemonstrationDigest(): string {
  return createHash("sha256").update(ANCHORED_EDIT_DEMONSTRATION_FRAGMENT, "utf8").digest("hex");
}

export interface CalibrationPromptOptions {
  readonly lineAnchoredEditingEnabled?: boolean;
  readonly anchoredEditDemonstrationEnabled?: boolean;
}

export class CalibrationManifestLoader {
  private cachedManifest?: BenchmarkManifest;

  constructor(
    private readonly manifestPath: string = path.resolve(
      process.cwd(),
      "benchmarks/calibration-v15/tasks.json",
    ),
  ) {}

  /**
   * Load and cryptographically seal the calibration manifest.
   */
  public loadManifest(): BenchmarkManifest {
    if (this.cachedManifest) {
      return this.cachedManifest;
    }

    if (!fs.existsSync(this.manifestPath)) {
      throw new Error(`Calibration manifest not found at: ${this.manifestPath}`);
    }

    const rawContent = fs.readFileSync(this.manifestPath, "utf8");
    const tasks: BenchmarkTask[] = JSON.parse(rawContent);

    if (!Array.isArray(tasks) || tasks.length !== 5) {
      throw new Error(`Invalid calibration manifest: expected exactly 5 tasks, got ${tasks?.length}`);
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
      manifestVersion: "1.5.0",
      manifestHash,
      createdAt: "2026-10-22T00:00:00.000Z",
      taskCount: tasks.length,
      tasks,
    };

    return this.cachedManifest;
  }

  /**
   * Constructs an untrusted prompt for the model without leaking expected patches or tests.
   */
  public buildUntrustedPromptForModel(
    task: BenchmarkTask,
    options?: CalibrationPromptOptions,
  ): string {
    const additionalSection = task.additionalFiles && task.additionalFiles.length > 0
      ? `\nADDITIONAL RELEVANT FILES:\n${task.additionalFiles.map((af) => `- ${af.path}`).join("\n")}\n`
      : "";

    const demonstrationSection = options?.anchoredEditDemonstrationEnabled
      ? `\n${ANCHORED_EDIT_DEMONSTRATION_FRAGMENT}\n`
      : "";

    if (options?.lineAnchoredEditingEnabled) {
      return `You are operating as an autonomous software-engineering agent within the Emerald Agent Fabric.

MISSION OBJECTIVE:
Task ID: ${task.taskId}
Title: ${task.title}
Difficulty: ${task.difficulty}

PROBLEM STATEMENT:
${task.issue}

PRIMARY SOURCE FILE:
${task.sourceFile}
${additionalSection}
AVAILABLE TOOLS:
- read_file: inspect file contents ({"path": string})
- edit_file_anchor: precisely replace a unique text snippet without rewriting whole file ({"path": string, "searchAnchor": string, "replacementText": string})
- write_file: write complete file ({"path": string, "content": string})
- search_code: search code patterns in workspace ({"pattern": string})
- git_status: check working tree modifications ({})
- git_diff: review working tree patch ({})
${demonstrationSection}
INSTRUCTIONS:
1. First inspect ${task.sourceFile} using read_file.
2. For bug fixes, PREFER edit_file_anchor to replace ONLY the exact buggy code lines without modifying or deleting the rest of the file. Use write_file only if completely replacing the whole file.
3. Review git_status and git_diff to ensure no unintended modifications.
4. Signal goal completion by setting isGoalReached: true.

OUTPUT FORMAT:
Respond ONLY with a single valid JSON object:
{
  "thought": "<concise explanation of your reasoning>",
  "toolName": "<read_file | edit_file_anchor | write_file | search_code | git_status | git_diff>",
  "toolInput": { <tool arguments> },
  "isGoalReached": <optional boolean, set to true when repair is complete>
}`;
    }

    return `You are operating as an autonomous software-engineering agent within the Emerald Agent Fabric.

MISSION OBJECTIVE:
Task ID: ${task.taskId}
Title: ${task.title}
Difficulty: ${task.difficulty}

PROBLEM STATEMENT:
${task.issue}

PRIMARY SOURCE FILE:
${task.sourceFile}
${additionalSection}
AVAILABLE TOOLS:
- read_file: inspect file contents ({"path": string})
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
}`;
  }

  /**
   * Reference solutions for harness pipeline validation control (Control C).
   * Kept strictly isolated from model prompts.
   */
  public getReferenceSolution(taskId: string): Record<string, string> {
    switch (taskId) {
      case "calib-001":
        return {
          "auth.js": `function authorizeTransaction(user, amount) {
  if (!user || typeof amount !== 'number' || amount <= 0) {
    return { approved: false, code: 'INVALID_INPUT' };
  }
  return { approved: true, code: 'AUTH_OK' };
}
module.exports = { authorizeTransaction };
`,
        };
      case "calib-002":
        return {
          "clamp.js": `function clampNumber(val, min, max) {
  if (val < min) return min;
  if (val > max) return max;
  return val;
}
module.exports = { clampNumber };
`,
        };
      case "calib-003":
        return {
          "average.js": `function averageScore(scores) {
  if (!scores || scores.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < scores.length; i++) {
    sum += scores[i];
  }
  return sum / scores.length;
}
module.exports = { averageScore };
`,
        };
      case "calib-004":
        return {
          "compress.js": `function compressString(str) {
  if (!str) return "";
  let out = "";
  let i = 0;
  while (i < str.length) {
    let count = 1;
    while (i + 1 < str.length && str[i] === str[i + 1]) {
      count++;
      i++;
    }
    out += String(count) + str[i];
    i++;
  }
  return out;
}
module.exports = { compressString };
`,
        };
      case "calib-005":
        return {
          "version.js": `const API_VERSION = "v2";
module.exports = { API_VERSION };
`,
        };
      default:
        return {};
    }
  }
}
