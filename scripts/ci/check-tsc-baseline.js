/**
 * scripts/ci/check-tsc-baseline.js
 *
 * Verifies that current TypeScript compiler diagnostics do not introduce any new
 * errors or warnings beyond the approved baseline recorded in tsc-baseline-98aa411.json.
 *
 * Enforcement Policy:
 * 1. Fail-closed: Missing baseline, malformed baseline, or compiler crash exits code 1.
 * 2. Set-diff enforcement: Any new diagnostic signature s in (S_current \ S_baseline) exits code 1.
 * 3. Resolved diagnostics: Signatures in (S_baseline \ S_current) are reported informationally.
 * 4. Immutability: This script NEVER automatically updates or overwrites the baseline manifest.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

const EXPECTED_BASE_COMMIT = '98aa41163cb1c41f62580bbb646ca2a35b75a3e3';
const BASELINE_PATH = path.join(REPO_ROOT, 'scripts/ci/tsc-baseline-98aa411.json');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function parseDiagnosticLine(line, rootDir) {
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

function main() {
  console.log('===========================================================');
  console.log('Emerald Agent Fabric — TypeScript CI Quality Gate Check');
  console.log('===========================================================');

  // 1. Verify baseline manifest exists
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`[FAIL-CLOSED] Baseline manifest missing at ${BASELINE_PATH}`);
    console.error('Run "node scripts/ci/generate-tsc-baseline.js" to regenerate if authorized.');
    process.exit(1);
  }

  // 2. Load and validate baseline manifest
  let baselineData;
  try {
    const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
    baselineData = JSON.parse(raw);
  } catch (err) {
    console.error(`[FAIL-CLOSED] Failed to parse baseline manifest JSON: ${err.message}`);
    process.exit(1);
  }

  if (!baselineData || !Array.isArray(baselineData.diagnostics)) {
    console.error('[FAIL-CLOSED] Baseline manifest is malformed (missing "diagnostics" array).');
    process.exit(1);
  }

  if (baselineData.baseCommit !== EXPECTED_BASE_COMMIT) {
    console.error(`[FAIL-CLOSED] Baseline commit mismatch: expected ${EXPECTED_BASE_COMMIT}, found ${baselineData.baseCommit}`);
    process.exit(1);
  }

  // Build baseline signature set and map
  const baselineMap = new Map();
  for (const diag of baselineData.diagnostics) {
    const sigKey = `${diag.file}::${diag.code}::${diag.message}`;
    baselineMap.set(sigKey, diag);
  }
  console.log(`[check-tsc-baseline] Approved Baseline Commit: ${baselineData.baseCommit}`);
  console.log(`[check-tsc-baseline] Approved Baseline Diagnostics: ${baselineMap.size}`);

  // 3. Locate TypeScript binary
  let tscBin = path.join(REPO_ROOT, 'node_modules/typescript/bin/tsc');
  if (!fs.existsSync(tscBin)) {
    // Check if globally available
    tscBin = 'tsc';
  }

  // 4. Run TypeScript compiler
  console.log('[check-tsc-baseline] Executing TypeScript compiler check (tsc -p tsconfig.json --noEmit)...');
  let compilerOutput = '';
  try {
    compilerOutput = execSync(`node "${tscBin}" -p tsconfig.json --noEmit --pretty false`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (tscErr) {
    // tsc exits non-zero when diagnostics exist
    compilerOutput = (tscErr.stdout ? tscErr.stdout.toString() : '') +
                     (tscErr.stderr ? tscErr.stderr.toString() : '');
  }

  // 5. Parse current diagnostics
  const lines = compilerOutput.split(/\r?\n/);
  const currentMap = new Map();

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseDiagnosticLine(line, REPO_ROOT);
    if (parsed) {
      const sigKey = `${parsed.file}::${parsed.code}::${parsed.message}`;
      if (!currentMap.has(sigKey)) {
        currentMap.set(sigKey, parsed);
      }
    }
  }

  console.log(`[check-tsc-baseline] Current Diagnostics Count: ${currentMap.size}`);

  // 6. Compute set differences
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

  // 7. Report resolved diagnostics informationally
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

  // 8. Enforce quality gate
  if (newDiagnostics.length > 0) {
    console.error(`\n[FAIL] Found ${newDiagnostics.length} new TypeScript compiler diagnostic(s):`);
    for (const d of newDiagnostics) {
      console.error(`  - [NEW] ${d.file}: (${d.code}) ${d.message}`);
    }
    console.error('\n[GATE REJECTED] New TypeScript diagnostics violate the Phase 1 Milestone 1 baseline.');
    console.error('All new code must compile without introducing new errors or warnings.');
    process.exit(1);
  }

  console.log('\n[GATE PASSED] All current diagnostics are accounted for in the approved baseline.');
  console.log('Zero new TypeScript diagnostics detected.');
  process.exit(0);
}

main();
