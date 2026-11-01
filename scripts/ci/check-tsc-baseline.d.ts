/**
 * Type declarations for scripts/ci/check-tsc-baseline.js
 */

export interface ParsedDiagnostic {
  file: string;
  code: string;
  message: string;
}

export interface BaselineCheckResult {
  success: boolean;
  exitCode: number;
  reason?: string;
  error?: unknown;
  signal?: string;
  status?: number;
  newDiagnostics?: ParsedDiagnostic[];
  resolvedDiagnostics?: ParsedDiagnostic[];
}

export interface RunBaselineCheckOptions {
  rootDir?: string;
  baselinePath?: string;
  tscBin?: string;
  expectedBaseCommit?: string;
  exitOnError?: boolean;
  spawnRunner?: (
    execPath: string,
    args: readonly string[],
    options: Record<string, unknown>
  ) => {
    status?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  };
}

export function normalizePath(p: string): string;
export function normalizeDiagnosticMessage(message: string): string;
export function parseDiagnosticLine(line: string, rootDir?: string): ParsedDiagnostic | null;
export function loadBaselineManifest(baselinePath: string, expectedBaseCommit?: string): unknown;
export function runBaselineCheck(options?: RunBaselineCheckOptions): BaselineCheckResult;
export function main(): void;
