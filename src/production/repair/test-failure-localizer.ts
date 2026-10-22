/**
 * Emerald Agent Fabric — Production V1.3: Test-Failure Localizer
 *
 * Implements bounded, advisory test-failure localization.
 *
 * Core Principle:
 * "The model proposes. The runtime governs. The sandbox executes. Diagnostics explain. The verifier decides. The evidence proves."
 *
 * Authority Invariant:
 * The localizer is strictly advisory. It possesses zero policy, capability, verification,
 * or terminal authority.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { TestFailureLocalization } from "./repair-types.js";

const execFileAsync = promisify(execFile);

export interface LocalizeTestOptions {
  readonly workspacePath: string;
  readonly testCommand: { cmd: string; args: string[] };
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export class TestFailureLocalizer {
  constructor(private readonly maxPayloadBytes: number = 8192) {}

  /**
   * Run targeted tests and localize failure details if they fail.
   * If tests pass, returns null (indicating clean test execution).
   */
  public async localize(options: LocalizeTestOptions): Promise<TestFailureLocalization | null> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 30000;
    const maxBytes = options.maxOutputBytes ?? this.maxPayloadBytes;

    const inputPayload = JSON.stringify({
      cmd: options.testCommand.cmd,
      args: options.testCommand.args,
      workspace: options.workspacePath,
    });
    const inputHash = createHash("sha256").update(inputPayload).digest("hex");

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      const res = await execFileAsync(options.testCommand.cmd, options.testCommand.args, {
        cwd: options.workspacePath,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          NODE_ENV: "test",
          CI: "true",
        },
      });
      stdout = res.stdout ?? "";
      stderr = res.stderr ?? "";
      exitCode = 0;
    } catch (err: any) {
      exitCode = typeof err.code === "number" ? err.code : 1;
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? err.message ?? "";
    }

    // If tests passed cleanly (exitCode 0), no failure to localize
    if (exitCode === 0) {
      return null;
    }

    const durationMs = Date.now() - startTime;
    const rawOutput = `${stdout}\n${stderr}`;

    // Extract structured failure details
    const parsed = this.parseTestOutput(rawOutput);

    // Format bounded summary (<= maxBytes)
    const formattedSummary = this.formatLocalizationObservation(
      options.testCommand,
      parsed.failingTests,
      parsed.failureMessages,
      parsed.localizedFiles,
      rawOutput,
      maxBytes,
    );

    const outputHash = createHash("sha256").update(formattedSummary).digest("hex");
    const localizationId = `loc-${createHash("sha256").update(`${inputHash}:${outputHash}`).digest("hex").slice(0, 16)}`;

    return {
      localizationId,
      testCommand: `${options.testCommand.cmd} ${options.testCommand.args.join(" ")}`,
      exitCode,
      failingTests: parsed.failingTests,
      failureMessages: parsed.failureMessages,
      localizedFiles: parsed.localizedFiles,
      rawSummary: formattedSummary,
      durationMs,
      inputHash,
      outputHash,
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };
  }

  /**
   * Parse test outputs from standard test frameworks (vitest, jest, node:test, mocha, etc.)
   */
  private parseTestOutput(output: string): {
    failingTests: string[];
    failureMessages: string[];
    localizedFiles: string[];
  } {
    const lines = output.split(/\r?\n/);
    const failingTests: string[] = [];
    const failureMessages: string[] = [];
    const localizedFilesSet = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Pattern 1: Failing test names (✕ test name, FAIL test name, not ok - test name)
      const failMatch = line.match(/(?:✕|FAIL|not ok|\bfail\b)\s+([^\n\r]+)/i);
      if (failMatch && failMatch[1]) {
        const cleanName = failMatch[1].trim();
        if (cleanName && !failingTests.includes(cleanName) && failingTests.length < 16) {
          failingTests.push(cleanName);
        }
      }

      // Pattern 2: Assertion error lines (AssertionError:, Error:, Expected:, Received:)
      const assertMatch = line.match(/(?:AssertionError|Assertion failed|Expected|Received|Error):\s*([^\n\r]+)/i);
      if (assertMatch && assertMatch[1]) {
        const cleanMsg = assertMatch[0].trim();
        if (cleanMsg && !failureMessages.includes(cleanMsg) && failureMessages.length < 16) {
          failureMessages.push(cleanMsg.slice(0, 256));
        }
      }

      // Pattern 3: Stack trace file references (at ... (path/to/file.ts:line:col))
      const fileMatch = line.match(/(?:at\s+.*?\()?([a-zA-Z0-9_\-\./\\]+\.(?:ts|js|jsx|tsx|mjs|cjs)):(\d+)(?::\d+)?\)?/);
      if (fileMatch && fileMatch[1]) {
        const filePath = fileMatch[1].replace(/\\/g, "/");
        if (!filePath.includes("node_modules") && !filePath.includes("internal/")) {
          localizedFilesSet.add(filePath);
        }
      }
    }

    return {
      failingTests,
      failureMessages,
      localizedFiles: Array.from(localizedFilesSet).slice(0, 8),
    };
  }

  /**
   * Format compact, structured observation text guaranteed to fit within maxBytes.
   */
  private formatLocalizationObservation(
    cmd: { cmd: string; args: string[] },
    failingTests: readonly string[],
    failureMessages: readonly string[],
    localizedFiles: readonly string[],
    rawOutput: string,
    maxBytes: number,
  ): string {
    const header = [
      `[TEST_FAILURE_LOCALIZATION (Advisory — Non-Authoritative)]`,
      `Command: ${cmd.cmd} ${cmd.args.join(" ")}`,
      `Failing Tests (${failingTests.length}):`,
      ...failingTests.map((t) => `  - ${t}`),
    ];

    if (failureMessages.length > 0) {
      header.push(`Failure Assertions:`);
      for (const msg of failureMessages) {
        header.push(`  * ${msg}`);
      }
    }

    if (localizedFiles.length > 0) {
      header.push(`Localized Source Files:`);
      for (const f of localizedFiles) {
        header.push(`  -> ${f}`);
      }
    }

    let result = header.join("\n");
    const remainingBytes = maxBytes - Buffer.byteLength(result, "utf8") - 200;

    if (remainingBytes > 100) {
      const excerpt = rawOutput.slice(0, remainingBytes).trim();
      result += `\nRaw Test Excerpt:\n${excerpt}\n...[truncated for context budget]`;
    }

    // Safety clamp
    const buf = Buffer.from(result, "utf8");
    if (buf.length > maxBytes) {
      return buf.subarray(0, maxBytes).toString("utf8");
    }
    return result;
  }
}
