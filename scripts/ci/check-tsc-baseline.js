/**
 * scripts/ci/check-tsc-baseline.js
 *
 * Verifies that current TypeScript compiler diagnostics do not introduce any new
 * errors or warnings beyond the approved baseline recorded in tsc-baseline-98aa411.json.
 *
 * Enforcement Policy (Milestone 2.1 Hardened):
 * 1. Fail-closed: Missing compiler executable, spawn errors, signal terminations,
 *    unexpected exit statuses, unparseable output, and malformed baselines exit code 1.
 * 2. Set-diff enforcement: Any new diagnostic signature s in (S_current \ S_baseline) exits code 1.
 * 3. Resolved diagnostics: Signatures in (S_baseline \ S_current) are reported informationally.
 * 4. Immutability: This script NEVER automatically updates or overwrites the baseline manifest.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

const EXPECTED_BASE_COMMIT = '98aa41163cb1c41f62580bbb646ca2a35b75a3e3';
const DEFAULT_BASELINE_PATH = path.join(REPO_ROOT, 'scripts/ci/tsc-baseline-98aa411.json');

/**
 * Normalizes Windows and POSIX file paths to forward-slash relative paths.
 */
export function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Parses a single diagnostic line emitted by `tsc --pretty false`.
 * Returns null if the line cannot be safely parsed as a valid diagnostic.
 */
export function parseDiagnosticLine(line, rootDir) {
  const normalizedLine = normalizePath(line.trim());
  const match = normalizedLine.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/);
  if (match) {
    let filePath = match[1];
    const normRoot = rootDir ? normalizePath(rootDir) : null;
    if (normRoot && filePath.toLowerCase().startsWith(normRoot.toLowerCase())) {
      filePath = filePath.slice(normRoot.length);
    }
    filePath = filePath.replace(/^[./\\]+/, '');
    return {
      file: filePath,
      code: match[5],
      message: match[6].trim()
    };
  }

  // Global diagnostics without file location:
  const globalMatch = normalizedLine.match(/^(error|warning)\s+(TS\d+):\s+(.+)$/);
  if (globalMatch) {
    return {
      file: '<global>',
      code: globalMatch[2],
      message: globalMatch[3].trim()
    };
  }

  return null;
}

/**
 * Validates the baseline manifest file and returns parsed data or throws an error with reason.
 */
export function loadBaselineManifest(baselinePath, expectedBaseCommit) {
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`[FAIL-CLOSED: BASELINE_MISSING] Baseline manifest missing at ${baselinePath}`);
  }

  let baselineData;
  try {
    const raw = fs.readFileSync(baselinePath, 'utf8');
    baselineData = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[FAIL-CLOSED: BASELINE_MALFORMED] Failed to parse baseline manifest JSON: ${err.message}`);
  }

  if (!baselineData || !Array.isArray(baselineData.diagnostics)) {
    throw new Error('[FAIL-CLOSED: BASELINE_SCHEMA_INVALID] Baseline manifest is malformed (missing "diagnostics" array).');
  }

  if (expectedBaseCommit && baselineData.baseCommit !== expectedBaseCommit) {
    throw new Error(`[FAIL-CLOSED: BASELINE_COMMIT_MISMATCH] Baseline commit mismatch: expected ${expectedBaseCommit}, found ${baselineData.baseCommit}`);
  }

  return baselineData;
}

/**
 * Executes the baseline check with full fail-closed classification.
 */
export function runBaselineCheck(options = {}) {
  const rootDir = options.rootDir || REPO_ROOT;
  const baselinePath = options.baselinePath || process.env.EMERALD_TSC_BASELINE_PATH || DEFAULT_BASELINE_PATH;
  const tscBin = options.tscBin || process.env.EMERALD_TSC_BIN || path.join(rootDir, 'node_modules/typescript/bin/tsc');
  const expectedBaseCommit = options.expectedBaseCommit !== undefined ? options.expectedBaseCommit : EXPECTED_BASE_COMMIT;
  const exitOnError = options.exitOnError !== undefined ? options.exitOnError : true;
  const runner = options.spawnRunner || null;

  console.log('===========================================================');
  console.log('Emerald Agent Fabric — TypeScript CI Quality Gate Check');
  console.log('===========================================================');

  // 1. Validate baseline manifest
  let baselineData;
  try {
    baselineData = loadBaselineManifest(baselinePath, expectedBaseCommit);
  } catch (manifestErr) {
    console.error(manifestErr.message);
    if (exitOnError) process.exit(1);
    return { success: false, exitCode: 1, reason: manifestErr.message };
  }

  // Build baseline signature map
  const baselineMap = new Map();
  for (const diag of baselineData.diagnostics) {
    const sigKey = `${diag.file}::${diag.code}::${diag.message}`;
    baselineMap.set(sigKey, diag);
  }
  console.log(`[check-tsc-baseline] Approved Baseline Commit: ${baselineData.baseCommit}`);
  console.log(`[check-tsc-baseline] Approved Baseline Diagnostics: ${baselineMap.size}`);

  // 2. Validate TypeScript compiler binary existence (Strict fail-closed, no shell fallback)
  if (!fs.existsSync(tscBin)) {
    const msg = `[FAIL-CLOSED: COMPILER_NOT_FOUND] TypeScript compiler executable missing at: ${tscBin}\nRun "npm ci" to install dependencies before running quality gate.`;
    console.error(msg);
    if (exitOnError) process.exit(1);
    return { success: false, exitCode: 1, reason: 'COMPILER_NOT_FOUND' };
  }

  // 3. Execute TypeScript compiler
  console.log(`[check-tsc-baseline] Executing TypeScript compiler check (${tscBin} -p tsconfig.json --noEmit)...`);
  const spawnArgs = [tscBin, '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false'];
  const spawnOpts = {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  };

  let spawnResult;
  try {
    if (runner) {
      spawnResult = runner(process.execPath, spawnArgs, spawnOpts);
    } else {
      spawnResult = spawnSync(process.execPath, spawnArgs, spawnOpts);
    }
  } catch (execErr) {
    // Process launch exception
    const msg = `[FAIL-CLOSED: LAUNCH_ERROR] Unexpected error executing TypeScript compiler: ${execErr.message}`;
    console.error(msg);
    if (exitOnError) process.exit(1);
    return { success: false, exitCode: 1, reason: 'LAUNCH_ERROR', error: execErr };
  }

  // 4. Classify spawn-level failures
  if (spawnResult.error) {
    const msg = `[FAIL-CLOSED: LAUNCH_ERROR] Process spawn failure: ${spawnResult.error.message}`;
    console.error(msg);
    if (exitOnError) process.exit(1);
    return { success: false, exitCode: 1, reason: 'LAUNCH_ERROR', error: spawnResult.error };
  }

  if (spawnResult.signal) {
    const msg = `[FAIL-CLOSED: SIGNAL_TERMINATION] TypeScript compiler terminated by signal: ${spawnResult.signal}`;
    console.error(msg);
    if (exitOnError) process.exit(1);
    return { success: false, exitCode: 1, reason: 'SIGNAL_TERMINATION', signal: spawnResult.signal };
  }

  const exitStatus = spawnResult.status;
  const stdout = spawnResult.stdout || '';
  const stderr = spawnResult.stderr || '';
  const combinedOutput = stdout + (stderr ? '\n' + stderr : '');

  // 5. Classify exit status codes
  // Valid exit statuses from TypeScript CLI:
  // 0: Success (0 diagnostics)
  // 1: DiagnosticsPresent_OutputsSkipped (when --noEmit is used and errors/diagnostics exist)
  // 2: DiagnosticsPresent_OutputsGenerated (diagnostics exist, outputs generated)
  // 3: InvalidProject_OutputsSkipped (Fatal project configuration / invalid tsconfig)
  // 4: ProjectReferenceCycle_OutputsSkipped (Fatal project reference cycle)
  if (exitStatus === 3 || exitStatus === 4) {
    const msg = `[FAIL-CLOSED: FATAL_PROJECT_ERROR] TypeScript compiler fatal configuration error (exit status ${exitStatus}).\nOutput:\n${combinedOutput.trim()}`;
    console.error(msg);
    if (exitOnError) process.exit(1);
    return { success: false, exitCode: 1, reason: 'FATAL_PROJECT_ERROR', status: exitStatus };
  }

  if (exitStatus !== 0 && exitStatus !== 1 && exitStatus !== 2) {
    const msg = `[FAIL-CLOSED: UNEXPECTED_EXIT_STATUS] TypeScript compiler exited with unexpected status code: ${exitStatus}.\nOutput:\n${combinedOutput.trim()}`;
    console.error(msg);
    if (exitOnError) process.exit(1);
    return { success: false, exitCode: 1, reason: 'UNEXPECTED_EXIT_STATUS', status: exitStatus };
  }

  // 6. Parse diagnostics from output
  const lines = combinedOutput.split(/\r?\n/);
  const currentMap = new Map();

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseDiagnosticLine(line, rootDir);
    if (parsed) {
      const sigKey = `${parsed.file}::${parsed.code}::${parsed.message}`;
      if (!currentMap.has(sigKey)) {
        currentMap.set(sigKey, parsed);
      }
    }
  }

  console.log(`[check-tsc-baseline] Current Diagnostics Count: ${currentMap.size}`);

  // 7. Output consistency validation
  // Non-zero exit code MUST produce at least one parsed diagnostic
  if (exitStatus !== 0 && currentMap.size === 0) {
    const msg = `[FAIL-CLOSED: UNPARSEABLE_OUTPUT] TypeScript compiler exited with error status ${exitStatus} but produced zero parseable diagnostics.\nOutput:\n${combinedOutput.trim()}`;
    console.error(msg);
    if (exitOnError) process.exit(1);
    return { success: false, exitCode: 1, reason: 'UNPARSEABLE_OUTPUT', status: exitStatus };
  }

  // Status 0 must not produce diagnostic lines
  if (exitStatus === 0 && currentMap.size > 0) {
    const msg = `[FAIL-CLOSED: STATUS_OUTPUT_MISMATCH] TypeScript compiler exited with status 0 but emitted ${currentMap.size} diagnostic(s).`;
    console.error(msg);
    if (exitOnError) process.exit(1);
    return { success: false, exitCode: 1, reason: 'STATUS_OUTPUT_MISMATCH' };
  }

  // 8. Compute set differences
  const newDiagnostics = [];
  for (const [key, diag] of currentMap.entries()) {
    if (!baselineMap.has(key)) {
      newDiagnostics.push(diag);
    }
  }

  const resolvedDiagnostics = [];
  for (const [key, diag] of baselineMap.entries()) {
    if (!currentMap.has(key)) {
      resolvedDiagnostics.push(diag);
    }
  }

  console.log('-----------------------------------------------------------');
  console.log(`[DIAGNOSTIC SUMMARY]`);
  console.log(`- Approved Baseline Total : ${baselineMap.size}`);
  console.log(`- Current Execution Total : ${currentMap.size}`);
  console.log(`- New Diagnostics         : ${newDiagnostics.length}`);
  console.log(`- Resolved Diagnostics    : ${resolvedDiagnostics.length}`);
  console.log('-----------------------------------------------------------');

  // 9. Report resolved diagnostics informationally
  if (resolvedDiagnostics.length > 0) {
    console.log(`[INFO] ${resolvedDiagnostics.length} diagnostic(s) present in baseline are resolved in current tree:`);
    const preview = resolvedDiagnostics.slice(0, 10);
    for (const d of preview) {
      console.log(`  - [RESOLVED] ${d.file}: (${d.code}) ${d.message}`);
    }
    if (resolvedDiagnostics.length > 10) {
      console.log(`  ... and ${resolvedDiagnostics.length - 10} more.`);
    }
    console.log('[INFO] Baseline manifest remains immutable per governance policy.');
  }

  // 10. Enforce quality gate
  if (newDiagnostics.length > 0) {
    console.error(`\n[FAIL] Found ${newDiagnostics.length} new TypeScript compiler diagnostic(s):`);
    for (const d of newDiagnostics) {
      console.error(`  - [NEW] ${d.file}: (${d.code}) ${d.message}`);
    }
    console.error('\n[GATE REJECTED] New TypeScript diagnostics violate the Phase 1 Milestone 1 baseline.');
    console.error('All new code must compile without introducing new errors or warnings.');
    if (exitOnError) process.exit(1);
    return {
      success: false,
      exitCode: 1,
      reason: 'NEW_DIAGNOSTICS',
      newDiagnostics,
      resolvedDiagnostics
    };
  }

  console.log('\n[GATE PASSED] All current diagnostics are accounted for in the approved baseline.');
  console.log('Zero new TypeScript diagnostics detected.');
  if (exitOnError) process.exit(0);
  return {
    success: true,
    exitCode: 0,
    newDiagnostics: [],
    resolvedDiagnostics
  };
}

export function main() {
  runBaselineCheck({ exitOnError: true });
}

// Auto-run if executed directly as script entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
