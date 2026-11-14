/**
 * Server-Defined Verification Operation Registry for Emerald Agent Fabric.
 *
 * Implements Phase 1 ADR-0043 Security Acceptance:
 * 1. REST clients can only request server-defined verification operations.
 * 2. Executable allowlists alone are NOT sufficient; arbitrary code execution flags
 *    (e.g., node -e, python -c) and arbitrary script execution are strictly rejected.
 * 3. Arguments, working directory, timeout, and capabilities are restricted by server-owned policy.
 * 4. Commands execute directly without shell interpretation.
 */

export const ALLOWED_VERIFICATION_EXECUTABLES = Object.freeze([
  "node",
  "npm",
  "npx",
  "vitest",
  "jest",
  "python",
  "python3",
  "pytest",
  "cargo",
  "go",
  "ruby",
  "rake",
  "rspec",
  "mvn",
  "gradle",
  "dotnet",
] as const);

export type AllowedVerificationExecutable =
  (typeof ALLOWED_VERIFICATION_EXECUTABLES)[number];

export const SHELL_METACHARACTER_REGEX = /[;&|`$><\n\r]/;

export const FORBIDDEN_CODE_EXECUTION_FLAGS = Object.freeze([
  "-e",
  "--eval",
  "-c",
  "--command",
  "-i",
  "--interactive",
  "-r",
  "--require",
  "--import",
  "--inspect",
  "--inspect-brk",
  "--prof",
  "--loader",
  "--experimental-loader",
  "--experimental-default-type",
]);

export const PATH_TRAVERSAL_REGEX = /(^\.\.$|^\.\.[\/\\]|[\/\\]\.\.[\/\\]|[\/\\]\.\.$)/;
export const ABSOLUTE_PATH_REGEX = /^([a-zA-Z]:[\/\\]|[\/\\])/;

export function tokenizeCommandLine(command: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(command)) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1].replace(/\\"/g, '"'));
    } else if (match[2] !== undefined) {
      tokens.push(match[2].replace(/\\'/g, "'"));
    } else if (match[3] !== undefined) {
      tokens.push(match[3]);
    }
  }
  return tokens;
}

export type ServerVerificationOperationId =
  | "node_test"
  | "python_test"
  | "npm_test"
  | "vitest_run"
  | "jest_run"
  | "pytest_run"
  | "cargo_test"
  | "go_test"
  | "ruby_test"
  | "mvn_test"
  | "gradle_test"
  | "dotnet_test";

export interface VerificationOperationValidationResult {
  readonly valid: boolean;
  readonly operationId?: ServerVerificationOperationId;
  readonly reason?: string;
}

/**
 * Validates a verification command argv vector against the server-defined operation registry.
 * Enforces executable allowlisting, forbids arbitrary code-eval flags, rejects path traversal
 * and absolute paths, and strictly checks subcommand rules.
 */
export function validateVerificationOperation(
  argv: readonly string[]
): VerificationOperationValidationResult {
  if (!argv || !Array.isArray(argv) || argv.length === 0) {
    return { valid: false, reason: "Verification argv must be a non-empty array of strings" };
  }

  // 1. Validate all elements are non-empty strings and have no metacharacters
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== "string" || arg.trim().length === 0) {
      return { valid: false, reason: `Verification argument at index ${i} must be a non-empty string` };
    }
    if (SHELL_METACHARACTER_REGEX.test(arg)) {
      return {
        valid: false,
        reason: `Argument '${arg}' contains forbidden shell metacharacters (; & | \` $ > < \\n \\r)`,
      };
    }
  }

  // 2. Resolve executable. It must be the bare server-defined name: a path-qualified executable
  //    (./node, bin/node, /usr/bin/node) could select a workspace-supplied binary instead.
  const rawExe = argv[0]!;
  if (/[\/\\]/.test(rawExe)) {
    return {
      valid: false,
      reason: `Executable '${rawExe}' must be a bare server-defined name without a path`,
    };
  }
  const baseExe = rawExe.toLowerCase();

  if (!ALLOWED_VERIFICATION_EXECUTABLES.includes(baseExe as AllowedVerificationExecutable)) {
    return {
      valid: false,
      reason: `Executable '${baseExe}' is not in the server-defined allowlisted verification operation registry (${ALLOWED_VERIFICATION_EXECUTABLES.join(", ")})`,
    };
  }

  // 3. Reject any code execution or inspection flags across all arguments
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const lowerArg = arg.toLowerCase();

    for (const flag of FORBIDDEN_CODE_EXECUTION_FLAGS) {
      if (lowerArg === flag || lowerArg.startsWith(`${flag}=`)) {
        return {
          valid: false,
          reason: `Flag '${arg}' is forbidden: arbitrary code execution and runtime debugging flags are prohibited in verification`,
        };
      }
    }

    // Check path safety if argument looks like a path or file
    if (PATH_TRAVERSAL_REGEX.test(arg)) {
      return {
        valid: false,
        reason: `Argument '${arg}' contains path traversal ('..') which is forbidden`,
      };
    }
    if (ABSOLUTE_PATH_REGEX.test(arg)) {
      return {
        valid: false,
        reason: `Argument '${arg}' is an absolute path; verification targets must be workspace-relative`,
      };
    }
  }

  // 4. Operation-specific structural validation
  switch (baseExe) {
    case "node": {
      // Must be a test script or node --test
      // e.g. ["node", "test-solver.js"] or ["node", "--test", "test.js"]
      if (argv.length < 2) {
        return { valid: false, reason: "node verification requires a target test script or '--test'" };
      }
      if (argv[1] === "--test") {
        // The built-in test runner: only workspace-relative test paths may follow. No further node
        // options are permitted here, because options such as -p/--print evaluate inline code.
        for (let i = 2; i < argv.length; i++) {
          if (argv[i]!.startsWith("-")) {
            return {
              valid: false,
              reason: `Option '${argv[i]}' is not permitted after 'node --test'; only test file paths may follow`,
            };
          }
        }
        return { valid: true, operationId: "node_test" };
      }
      const targetScript = argv[1]!;
      if (targetScript.startsWith("-") || !/\.(js|mjs|cjs|ts)$/i.test(targetScript)) {
        return {
          valid: false,
          reason: `Target script '${targetScript}' must be a script path with a valid extension (.js, .mjs, .cjs, .ts)`,
        };
      }
      return { valid: true, operationId: "node_test" };
    }

    case "python":
    case "python3": {
      // e.g. ["python3", "test_solver.py"] or ["python3", "-m", "unittest", ...] or ["python3", "-m", "pytest", ...]
      if (argv.length < 2) {
        return { valid: false, reason: "python verification requires a target test script or '-m unittest/pytest'" };
      }
      if (argv[1] === "-m") {
        const mod = argv[2]?.toLowerCase();
        if (mod !== "unittest" && mod !== "pytest") {
          return {
            valid: false,
            reason: `python module execution is restricted to unittest or pytest; '${argv[2]}' is not permitted`,
          };
        }
      } else {
        const targetScript = argv[1]!;
        if (!/\.py$/i.test(targetScript)) {
          return {
            valid: false,
            reason: `Target python script '${targetScript}' must end with .py`,
          };
        }
      }
      return { valid: true, operationId: "python_test" };
    }

    case "npm": {
      // npm test or npm run test
      if (argv.length < 2) {
        return { valid: false, reason: "npm verification requires a subcommand (e.g. 'npm test')" };
      }
      const sub = argv[1]?.toLowerCase();
      if (sub !== "test" && !(sub === "run" && argv[2]?.toLowerCase() === "test")) {
        return {
          valid: false,
          reason: `npm verification is restricted to the 'test' subcommand; '${sub}' is not permitted`,
        };
      }
      return { valid: true, operationId: "npm_test" };
    }

    case "npx": {
      if (argv.length < 2) {
        return { valid: false, reason: "npx verification requires a runner (e.g. 'npx vitest', 'npx jest')" };
      }
      const runner = argv[1]?.toLowerCase();
      if (runner === "vitest") return { valid: true, operationId: "vitest_run" };
      if (runner === "jest") return { valid: true, operationId: "jest_run" };
      return {
        valid: false,
        reason: `npx verification is restricted to 'vitest' and 'jest'; '${runner}' is not permitted`,
      };
    }

    case "vitest":
      return { valid: true, operationId: "vitest_run" };

    case "jest":
      return { valid: true, operationId: "jest_run" };

    case "pytest":
      return { valid: true, operationId: "pytest_run" };

    case "cargo": {
      if (argv.length < 2 || argv[1]?.toLowerCase() !== "test") {
        return { valid: false, reason: "cargo verification is restricted to 'cargo test'" };
      }
      return { valid: true, operationId: "cargo_test" };
    }

    case "go": {
      if (argv.length < 2 || argv[1]?.toLowerCase() !== "test") {
        return { valid: false, reason: "go verification is restricted to 'go test'" };
      }
      // -exec / -toolexec run an arbitrary program in place of the test binary or toolchain.
      for (let i = 2; i < argv.length; i++) {
        const opt = argv[i]!.toLowerCase().replace(/^--/, "-");
        if (/^-(exec|toolexec)(=|$)/.test(opt)) {
          return { valid: false, reason: `go test option '${argv[i]}' is forbidden: it executes an arbitrary program` };
        }
      }
      return { valid: true, operationId: "go_test" };
    }

    case "ruby": {
      // Only a workspace-relative test script; no interpreter options (e.g. fused -rLIB, -x).
      const script = argv[1];
      if (!script || script.startsWith("-") || !/\.rb$/i.test(script)) {
        return { valid: false, reason: "ruby verification requires a target '.rb' test script and no interpreter options" };
      }
      return { valid: true, operationId: "ruby_test" };
    }

    case "rake":
    case "rspec": {
      // Fused short options (-rLIB, -eCODE) load or evaluate code outside the declared test target.
      for (let i = 1; i < argv.length; i++) {
        if (/^-[er]./i.test(argv[i]!)) {
          return { valid: false, reason: `Option '${argv[i]}' is forbidden for ${baseExe} verification` };
        }
      }
      return { valid: true, operationId: "ruby_test" };
    }

    case "mvn": {
      if (argv.length < 2 || argv[1]?.toLowerCase() !== "test") {
        return { valid: false, reason: "mvn verification is restricted to 'mvn test'" };
      }
      return { valid: true, operationId: "mvn_test" };
    }

    case "gradle": {
      if (argv.length < 2 || argv[1]?.toLowerCase() !== "test") {
        return { valid: false, reason: "gradle verification is restricted to 'gradle test'" };
      }
      return { valid: true, operationId: "gradle_test" };
    }

    case "dotnet": {
      if (argv.length < 2 || argv[1]?.toLowerCase() !== "test") {
        return { valid: false, reason: "dotnet verification is restricted to 'dotnet test'" };
      }
      return { valid: true, operationId: "dotnet_test" };
    }

    default:
      return { valid: false, reason: `Unsupported verification executable: '${baseExe}'` };
  }
}
