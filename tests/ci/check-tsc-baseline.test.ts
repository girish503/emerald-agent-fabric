/**
 * tests/ci/check-tsc-baseline.test.ts
 *
 * Deterministic unit and integration tests for scripts/ci/check-tsc-baseline.js.
 * Verifies all Milestone 2.1 hardening failure modes (T1–T9).
 *
 * Constraints:
 * - Isolated temporary directories for all test fixtures.
 * - No network access, no Docker, no external dependencies.
 * - Preserves immutability of production baseline files.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadBaselineManifest,
  normalizePath,
  parseDiagnosticLine,
  runBaselineCheck
} from '../../scripts/ci/check-tsc-baseline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const CHECK_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/ci/check-tsc-baseline.js');

describe('scripts/ci/check-tsc-baseline.js (Milestone 2.1 Hardening)', () => {
  let tempDir: string;
  let dummyTscBin: string;
  let validBaselinePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emerald-test-gate-'));
    dummyTscBin = path.join(tempDir, 'tsc.js');
    fs.writeFileSync(dummyTscBin, '// dummy tsc binary for test\n', 'utf8');

    validBaselinePath = path.join(tempDir, 'baseline.json');
    const validManifest = {
      baseCommit: '98aa41163cb1c41f62580bbb646ca2a35b75a3e3',
      toolchain: {
        nodeVersion: 'v24.20.0',
        typescriptVersion: '5.9.3',
        platform: 'win32',
        tsconfig: 'tsconfig.json'
      },
      generatedAt: new Date().toISOString(),
      totalDiagnostics: 2,
      diagnostics: [
        {
          file: 'src/example-a.ts',
          code: 'TS2345',
          message: "Argument of type 'string' is not assignable to 'number'."
        },
        {
          file: 'src/example-b.ts',
          code: 'TS18048',
          message: "'val' is possibly 'undefined'."
        }
      ]
    };
    fs.writeFileSync(validBaselinePath, JSON.stringify(validManifest, null, 2), 'utf8');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in test
    }
  });

  // T1: Missing compiler binary
  describe('T1 — Missing compiler binary', () => {
    it('fails closed when compiler executable does not exist', () => {
      const nonExistentBin = path.join(tempDir, 'nonexistent-tsc.js');
      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: validBaselinePath,
        tscBin: nonExistentBin,
        exitOnError: false
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toBe('COMPILER_NOT_FOUND');
    });

    it('exits with code 1 in subprocess when compiler is missing', () => {
      const nonExistentBin = path.join(tempDir, 'nonexistent-tsc.js');
      const sub = spawnSync(process.execPath, [CHECK_SCRIPT_PATH], {
        env: {
          ...process.env,
          EMERALD_TSC_BIN: nonExistentBin,
          EMERALD_TSC_BASELINE_PATH: validBaselinePath
        },
        encoding: 'utf8'
      });

      expect(sub.status).toBe(1);
      expect(sub.stderr).toContain('[FAIL-CLOSED: COMPILER_NOT_FOUND]');
    });
  });

  // T2: Process launch error (e.g. spawn ENOENT or permission failure)
  describe('T2 — Process launch error', () => {
    it('fails closed when spawnRunner returns an error', () => {
      const spawnErr = new Error('spawn ENOENT (simulated)');
      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: validBaselinePath,
        tscBin: dummyTscBin,
        exitOnError: false,
        spawnRunner: () => ({
          error: spawnErr,
          status: null,
          signal: null,
          stdout: '',
          stderr: spawnErr.message
        })
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toBe('LAUNCH_ERROR');
    });
  });

  // T3: Signal termination
  describe('T3 — Signal termination', () => {
    it('fails closed when compiler process is terminated by SIGKILL', () => {
      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: validBaselinePath,
        tscBin: dummyTscBin,
        exitOnError: false,
        spawnRunner: () => ({
          status: null,
          signal: 'SIGKILL',
          stdout: '',
          stderr: 'Killed'
        })
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toBe('SIGNAL_TERMINATION');
      expect(result.signal).toBe('SIGKILL');
    });

    it('fails closed when compiler process is terminated by SIGSEGV', () => {
      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: validBaselinePath,
        tscBin: dummyTscBin,
        exitOnError: false,
        spawnRunner: () => ({
          status: null,
          signal: 'SIGSEGV',
          stdout: '',
          stderr: 'Segmentation fault'
        })
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toBe('SIGNAL_TERMINATION');
      expect(result.signal).toBe('SIGSEGV');
    });
  });

  // T4: Fatal/unparseable compiler output
  describe('T4 — Fatal/unparseable compiler output', () => {
    it('fails closed when compiler exits non-zero but produces zero parseable diagnostics', () => {
      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: validBaselinePath,
        tscBin: dummyTscBin,
        exitOnError: false,
        spawnRunner: () => ({
          status: 1,
          signal: null,
          stdout: '',
          stderr: 'Fatal Error: JavaScript heap out of memory\nCannot allocate 2147483648 bytes'
        })
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toBe('UNPARSEABLE_OUTPUT');
    });

    it('fails closed when compiler exits with status 3 (InvalidProject_OutputsSkipped)', () => {
      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: validBaselinePath,
        tscBin: dummyTscBin,
        exitOnError: false,
        spawnRunner: () => ({
          status: 3,
          signal: null,
          stdout: 'error TS5083: Cannot read file tsconfig.json\n',
          stderr: ''
        })
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toBe('FATAL_PROJECT_ERROR');
    });

    it('fails closed when compiler exits with unexpected status code', () => {
      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: validBaselinePath,
        tscBin: dummyTscBin,
        exitOnError: false,
        spawnRunner: () => ({
          status: 127,
          signal: null,
          stdout: 'command not found\n',
          stderr: ''
        })
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toBe('UNEXPECTED_EXIT_STATUS');
    });

    it('fails closed if status is 0 but diagnostic lines are present', () => {
      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: validBaselinePath,
        tscBin: dummyTscBin,
        exitOnError: false,
        spawnRunner: () => ({
          status: 0,
          signal: null,
          stdout: 'src/example-a.ts(10,5): error TS2345: Argument of type string is not assignable to number.\n',
          stderr: ''
        })
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toBe('STATUS_OUTPUT_MISMATCH');
    });
  });

  // T5: Clean compile (0 diagnostics and status 0)
  describe('T5 — Clean compile', () => {
    it('passes when compiler succeeds with 0 diagnostics', () => {
      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: validBaselinePath,
        tscBin: dummyTscBin,
        exitOnError: false,
        spawnRunner: () => ({
          status: 0,
          signal: null,
          stdout: '',
          stderr: ''
        })
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.newDiagnostics).toHaveLength(0);
      // All 2 diagnostics in baseline are reported as resolved
      expect(result.resolvedDiagnostics).toHaveLength(2);
    });
  });

  // T6: Baseline match (known diagnostics match without reporting new)
  describe('T6 — Baseline match', () => {
    it('passes when compiler diagnostics exactly match the approved baseline', () => {
      const compilerOutput = [
        'src/example-a.ts(12,4): error TS2345: Argument of type \'string\' is not assignable to \'number\'.',
        'src/example-b.ts(45,1): error TS18048: \'val\' is possibly \'undefined\'.'
      ].join('\n') + '\n';

      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: validBaselinePath,
        tscBin: dummyTscBin,
        exitOnError: false,
        spawnRunner: () => ({
          status: 1,
          signal: null,
          stdout: compilerOutput,
          stderr: ''
        })
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.newDiagnostics).toHaveLength(0);
      expect(result.resolvedDiagnostics).toHaveLength(0);
    });
  });

  // T7: New diagnostic outside baseline
  describe('T7 — New diagnostic', () => {
    it('fails closed when compiler introduces an unbaselined diagnostic', () => {
      const compilerOutput = [
        'src/example-a.ts(12,4): error TS2345: Argument of type \'string\' is not assignable to \'number\'.',
        'src/example-b.ts(45,1): error TS18048: \'val\' is possibly \'undefined\'.',
        'src/new-feature.ts(5,2): error TS2304: Cannot find name \'undeclaredVariable\'.'
      ].join('\n') + '\n';

      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: validBaselinePath,
        tscBin: dummyTscBin,
        exitOnError: false,
        spawnRunner: () => ({
          status: 1,
          signal: null,
          stdout: compilerOutput,
          stderr: ''
        })
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toBe('NEW_DIAGNOSTICS');
      expect(result.newDiagnostics).toHaveLength(1);
      expect(result.newDiagnostics?.[0]?.file).toBe('src/new-feature.ts');
      expect(result.newDiagnostics?.[0]?.code).toBe('TS2304');
    });
  });

  // T8 — Resolved diagnostic
  describe('T8 — Resolved diagnostic', () => {
    it('reports resolved diagnostic informationally without mutating baseline file', () => {
      const beforeContent = fs.readFileSync(validBaselinePath, 'utf8');

      // Only 1 of the 2 baseline diagnostics is emitted (example-b is resolved)
      const compilerOutput = 'src/example-a.ts(12,4): error TS2345: Argument of type \'string\' is not assignable to \'number\'.\n';

      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: validBaselinePath,
        tscBin: dummyTscBin,
        exitOnError: false,
        spawnRunner: () => ({
          status: 1,
          signal: null,
          stdout: compilerOutput,
          stderr: ''
        })
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.newDiagnostics).toHaveLength(0);
      expect(result.resolvedDiagnostics).toHaveLength(1);
      expect(result.resolvedDiagnostics?.[0]?.file).toBe('src/example-b.ts');

      // Invariant: Baseline manifest must not be mutated
      const afterContent = fs.readFileSync(validBaselinePath, 'utf8');
      expect(afterContent).toBe(beforeContent);
    });
  });

  // T9 — Malformed manifest
  describe('T9 — Malformed manifest', () => {
    it('fails closed when baseline file is missing', () => {
      const missingPath = path.join(tempDir, 'missing-baseline.json');
      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: missingPath,
        tscBin: dummyTscBin,
        exitOnError: false
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toContain('BASELINE_MISSING');
    });

    it('fails closed when baseline file contains invalid JSON', () => {
      const corruptPath = path.join(tempDir, 'corrupt.json');
      fs.writeFileSync(corruptPath, '{ "baseCommit": invalid json', 'utf8');

      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: corruptPath,
        tscBin: dummyTscBin,
        exitOnError: false
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toContain('BASELINE_MALFORMED');
    });

    it('fails closed when baseline file lacks diagnostics array', () => {
      const invalidSchemaPath = path.join(tempDir, 'no-diag.json');
      fs.writeFileSync(invalidSchemaPath, JSON.stringify({ baseCommit: '98aa41163cb1c41f62580bbb646ca2a35b75a3e3' }), 'utf8');

      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: invalidSchemaPath,
        tscBin: dummyTscBin,
        exitOnError: false
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toContain('BASELINE_SCHEMA_INVALID');
    });

    it('fails closed when baseline commit does not match expectedBaseCommit', () => {
      const wrongCommitPath = path.join(tempDir, 'wrong-commit.json');
      fs.writeFileSync(wrongCommitPath, JSON.stringify({
        baseCommit: '0000000000000000000000000000000000000000',
        diagnostics: []
      }), 'utf8');

      const result = runBaselineCheck({
        rootDir: tempDir,
        baselinePath: wrongCommitPath,
        tscBin: dummyTscBin,
        exitOnError: false
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toContain('BASELINE_COMMIT_MISMATCH');
    });
  });

  // Diagnostic Line Parser Invariants
  describe('parseDiagnosticLine invariants', () => {
    it('parses typical non-pretty TypeScript diagnostic line', () => {
      const line = 'src/app/core.ts(15,22): error TS2345: Argument is not assignable.';
      const parsed = parseDiagnosticLine(line, '/fake/root');
      expect(parsed).toEqual({
        file: 'src/app/core.ts',
        code: 'TS2345',
        message: 'Argument is not assignable.'
      });
    });

    it('strips absolute root directory prefix from file path', () => {
      const line = `${tempDir}/src/app/core.ts(15,22): error TS2345: Argument is not assignable.`;
      const parsed = parseDiagnosticLine(line, tempDir);
      expect(parsed).toEqual({
        file: 'src/app/core.ts',
        code: 'TS2345',
        message: 'Argument is not assignable.'
      });
    });

    it('parses global diagnostics without file location', () => {
      const line = 'error TS5023: Unknown compiler option \'foo\'.';
      const parsed = parseDiagnosticLine(line, tempDir);
      expect(parsed).toEqual({
        file: '<global>',
        code: 'TS5023',
        message: 'Unknown compiler option \'foo\'.'
      });
    });

    it('returns null for non-diagnostic output', () => {
      expect(parseDiagnosticLine('Starting compilation...', tempDir)).toBeNull();
      expect(parseDiagnosticLine('Fatal error: Out of memory', tempDir)).toBeNull();
      expect(parseDiagnosticLine('', tempDir)).toBeNull();
    });
  });
});
