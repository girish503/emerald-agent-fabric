/**
 * Emerald Agent Fabric — Production V1.4: Mandatory Measurement Gate
 *
 * Measures actual model-facing test-failure payloads across the 15 benchmark tasks.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BenchmarkManifestLoader } from "../src/production/benchmark/benchmark-manifest.js";
import { TestFailureLocalizer } from "../src/production/repair/test-failure-localizer.js";

const execFileAsync = promisify(execFile);

async function measure() {
  console.log("================================================================================");
  console.log("PRODUCTION V1.4: MANDATORY MEASUREMENT GATE");
  console.log("Measuring Actual Model-Facing Test Failure Feedback Payloads");
  console.log("================================================================================");

  const loader = new BenchmarkManifestLoader();
  const manifest = loader.loadManifest();
  const localizer = new TestFailureLocalizer(8192); // Existing V1.3 budget

  const records: any[] = [];
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-measure-"));

  for (let i = 0; i < manifest.tasks.length; i++) {
    const task = manifest.tasks[i]!;
    const taskDir = path.join(tempBase, task.taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    // Write initial bugged code and test file
    fs.writeFileSync(path.join(taskDir, task.sourceFile), task.initialCode, "utf8");
    fs.writeFileSync(path.join(taskDir, task.testFile), task.testCode, "utf8");

    // Execute test command directly
    let rawOutput = "";
    try {
      const res = await execFileAsync(task.testCommand.cmd, task.testCommand.args as string[], {
        cwd: taskDir,
        timeout: 10000,
      });
      rawOutput = `${res.stdout}\n${res.stderr}`;
    } catch (err: any) {
      rawOutput = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`;
    }

    const rawBytes = Buffer.byteLength(rawOutput, "utf8");

    // Run existing V1.3 localizer
    const localization = await localizer.localize({
      workspacePath: taskDir,
      testCommand: { cmd: task.testCommand.cmd, args: task.testCommand.args as string[] },
      timeoutMs: 10000,
    });

    const localizedBytes = localization ? Buffer.byteLength(localization.rawSummary, "utf8") : 0;
    const failingTestsCount = localization?.failingTests.length ?? 0;
    const failureMessagesCount = localization?.failureMessages.length ?? 0;
    const localizedFilesCount = localization?.localizedFiles.length ?? 0;
    const isTruncated = localization?.rawSummary.includes("...[truncated for context budget]") ?? false;

    records.push({
      taskId: task.taskId,
      difficulty: task.difficulty,
      rawBytes,
      localizedBytes,
      failingTestsCount,
      failureMessagesCount,
      localizedFilesCount,
      isTruncated,
    });

    console.log(
      `Task [${i + 1}/15] ${task.taskId}: RawOutput=${rawBytes}B, LocalizedPayload=${localizedBytes}B, FailingTests=${failingTestsCount}, Assertions=${failureMessagesCount}, Truncated=${isTruncated}`,
    );
  }

  // Cleanup
  fs.rmSync(tempBase, { recursive: true, force: true });

  const totalRaw = records.reduce((s, r) => s + r.rawBytes, 0);
  const totalLocalized = records.reduce((s, r) => s + r.localizedBytes, 0);
  const meanRaw = Math.round(totalRaw / records.length);
  const meanLocalized = Math.round(totalLocalized / records.length);
  const maxLocalized = Math.max(...records.map((r) => r.localizedBytes));
  const minLocalized = Math.min(...records.map((r) => r.localizedBytes));
  const truncatedCount = records.filter((r) => r.isTruncated).length;

  console.log("\n--------------------------------------------------------------------------------");
  console.log("SUMMARY OF BASELINE TEST-FAILURE PAYLOAD MEASUREMENTS");
  console.log("--------------------------------------------------------------------------------");
  console.log(`Mean Raw Test Output:        ${meanRaw} bytes`);
  console.log(`Mean Localized Payload:      ${meanLocalized} bytes`);
  console.log(`Max Localized Payload:       ${maxLocalized} bytes`);
  console.log(`Min Localized Payload:       ${minLocalized} bytes`);
  console.log(`Truncation Frequency:        ${truncatedCount}/15 (${((truncatedCount / 15) * 100).toFixed(1)}%)`);
  console.log(`Available Context Budget:    8,192 bytes (V1.3 localization budget)`);
  console.log(`Max Model Context (Qwen3B):  ~16,384 - 32,768 bytes (~4k - 8k tokens)`);
  console.log(`Proportion Consumed:         ${((meanLocalized / 8192) * 100).toFixed(1)}% of localization budget`);
  console.log("--------------------------------------------------------------------------------\n");

  fs.writeFileSync("scratch/production-v14-baseline-measurements.json", JSON.stringify(records, null, 2), "utf8");
}

measure().catch(console.error);
