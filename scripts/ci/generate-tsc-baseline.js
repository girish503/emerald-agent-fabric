/**
 * scripts/ci/generate-tsc-baseline.js
 *
 * Captures an authoritative, structured TypeScript diagnostic baseline from an
 * isolated clean snapshot of exact commit 98aa41163cb1c41f62580bbb646ca2a35b75a3e3.
 *
 * Invariant: Never derives the baseline from the dirty working tree.
 * Invariant: Records structured diagnostic signatures (file, code, normalized message),
 *            avoiding physical line numbers as primary diagnostic identity.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

const APPROVED_BASE_COMMIT = '98aa41163cb1c41f62580bbb646ca2a35b75a3e3';
const OUTPUT_BASELINE_PATH = path.join(REPO_ROOT, 'scripts/ci/tsc-baseline-98aa411.json');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function parseDiagnosticLine(line, rootDir) {
  // Typical tsc output with --pretty false:
  // path/to/file.ts(line,col): error TS<code>: <message>
  // or: error TS<code>: <message>
  const normalizedLine = normalizePath(line.trim());
  const match = normalizedLine.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/);
  if (match) {
    let filePath = match[1];
    if (rootDir && filePath.startsWith(normalizePath(rootDir))) {
      filePath = filePath.slice(normalizePath(rootDir).length).replace(/^\//, '');
    }
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

function main() {
  console.log(`[generate-tsc-baseline] Target Base Commit: ${APPROVED_BASE_COMMIT}`);

  // 1. Verify git is available and base commit exists
  try {
    const revCheck = execSync(`git rev-parse --verify ${APPROVED_BASE_COMMIT}`, {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    }).trim();
    if (revCheck !== APPROVED_BASE_COMMIT) {
      throw new Error(`Revision mismatch: expected ${APPROVED_BASE_COMMIT}, got ${revCheck}`);
    }
  } catch (err) {
    console.error(`[generate-tsc-baseline] Failed to verify base commit: ${err.message}`);
    process.exit(1);
  }

  // 2. Identify local TypeScript binary and version
  const tscBin = path.join(REPO_ROOT, 'node_modules/typescript/bin/tsc');
  if (!fs.existsSync(tscBin)) {
    console.error(`[generate-tsc-baseline] TypeScript binary not found at ${tscBin}`);
    process.exit(1);
  }

  const tsPkgJsonPath = path.join(REPO_ROOT, 'node_modules/typescript/package.json');
  let tsVersion = 'unknown';
  if (fs.existsSync(tsPkgJsonPath)) {
    try {
      const tsPkg = JSON.parse(fs.readFileSync(tsPkgJsonPath, 'utf8'));
      tsVersion = tsPkg.version || 'unknown';
    } catch {
      // ignore
    }
  }

  // 3. Create isolated temporary directory
  const tempSnapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emerald-tsc-baseline-'));
  console.log(`[generate-tsc-baseline] Created clean isolated snapshot dir: ${tempSnapshotDir}`);

  let tarArchiveExtracted = false;
  try {
    // 4. Extract exact base commit using git archive & tar into isolated directory
    const archiveCmd = `git archive ${APPROVED_BASE_COMMIT} | tar -x -C "${tempSnapshotDir}"`;
    execSync(archiveCmd, { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    tarArchiveExtracted = true;
    console.log(`[generate-tsc-baseline] Clean snapshot of ${APPROVED_BASE_COMMIT} extracted successfully.`);

    // 5. Link node_modules into the temporary directory for dependency resolution
    const repoNodeModules = path.join(REPO_ROOT, 'node_modules');
    const tempNodeModules = path.join(tempSnapshotDir, 'node_modules');
    const isWindows = process.platform === 'win32';
    fs.symlinkSync(repoNodeModules, tempNodeModules, isWindows ? 'junction' : 'dir');

    // 6. Execute tsc in the isolated directory against its tsconfig.json
    console.log(`[generate-tsc-baseline] Executing TypeScript compiler on clean snapshot...`);
    let compilerOutput = '';
    try {
      compilerOutput = execSync(`node "${tscBin}" -p tsconfig.json --noEmit --pretty false`, {
        cwd: tempSnapshotDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 20 * 1024 * 1024
      });
    } catch (tscErr) {
      // tsc exits with code > 0 when diagnostics exist; capture stdout + stderr
      compilerOutput = (tscErr.stdout ? tscErr.stdout.toString() : '') +
                       (tscErr.stderr ? tscErr.stderr.toString() : '');
    }

    // 7. Parse diagnostics deterministically
    const lines = compilerOutput.split(/\r?\n/);
    const signatureMap = new Map();

    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseDiagnosticLine(line, tempSnapshotDir);
      if (parsed) {
        // Construct canonical signature key: normalized file + code + message
        const sigKey = `${parsed.file}::${parsed.code}::${parsed.message}`;
        if (!signatureMap.has(sigKey)) {
          signatureMap.set(sigKey, {
            file: parsed.file,
            code: parsed.code,
            message: parsed.message
          });
        }
      }
    }

    const sortedDiagnostics = Array.from(signatureMap.values()).sort((a, b) => {
      const cmpFile = a.file.localeCompare(b.file);
      if (cmpFile !== 0) return cmpFile;
      const cmpCode = a.code.localeCompare(b.code);
      if (cmpCode !== 0) return cmpCode;
      return a.message.localeCompare(b.message);
    });

    console.log(`[generate-tsc-baseline] Successfully parsed ${sortedDiagnostics.length} unique diagnostic signatures.`);

    // 8. Build baseline manifest structure
    const manifest = {
      baseCommit: APPROVED_BASE_COMMIT,
      toolchain: {
        nodeVersion: process.version,
        typescriptVersion: tsVersion,
        platform: process.platform,
        tsconfig: 'tsconfig.json'
      },
      generatedAt: new Date().toISOString(),
      totalDiagnostics: sortedDiagnostics.length,
      diagnostics: sortedDiagnostics
    };

    // Ensure output directory exists and write manifest
    fs.mkdirSync(path.dirname(OUTPUT_BASELINE_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_BASELINE_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`[generate-tsc-baseline] Baseline manifest successfully written to ${OUTPUT_BASELINE_PATH}`);

  } finally {
    // 9. Clean up isolated snapshot directory
    try {
      if (tarArchiveExtracted) {
        const tempNodeModules = path.join(tempSnapshotDir, 'node_modules');
        if (fs.existsSync(tempNodeModules)) {
          fs.rmSync(tempNodeModules, { recursive: false, force: true });
        }
      }
      fs.rmSync(tempSnapshotDir, { recursive: true, force: true });
      console.log(`[generate-tsc-baseline] Cleaned up temporary directory: ${tempSnapshotDir}`);
    } catch (cleanupErr) {
      console.warn(`[generate-tsc-baseline] Warning: Failed to fully remove temp dir: ${cleanupErr.message}`);
    }
  }
}

main();
