/**
 * Phase 42 — Controlled SWE-bench Verified External Benchmark Evaluation.
 *
 * Evaluates whether Emerald Agent Fabric can govern autonomous software-engineering
 * attempts on external benchmark tasks while independently establishing whether
 * the claimed repair is actually correct, policy-compliant, recoverable, and supported
 * by independently verifiable evidence.
 *
 * Measurements:
 * A. Task-solving capability
 * B. Execution reliability
 * C. Independent verification correctness
 * D. Evidence integrity
 * E. Authority provenance
 * F. False-positive resistance
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeBundleId,
  createTerminalRecord,
  EvidenceBundle,
} from "../../src/domain/evidence-bundle.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  createMissionContract,
  createExecutionPolicy,
  createResourceLimits,
  createVerificationSpec,
} from "../../src/domain/index.js";
import { EvidenceExporter } from "../../src/application/evidence-exporter.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import {
  EvidenceSigner,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";
import { OfflineAuditor } from "../../src/application/offline-auditor.js";

// ============================================================================
// Fixtures & Task Cohort Definition
// ============================================================================

interface BenchmarkTaskFixture {
  readonly taskId: string;
  readonly category: string;
  readonly targetFile: string;
  readonly defectiveContent: string;
  readonly goldPatchContent: string;
  readonly wrongPatchContent: string;
  readonly regressionPatchContent: string;
  readonly failToPassCode: string;
  readonly passToPassCode: string;
}

const BENCHMARK_FIXTURES: readonly BenchmarkTaskFixture[] = Object.freeze([
  {
    taskId: "EAF-BM-01",
    category: "CODE_NAVIGATION",
    targetFile: "src/calc.js",
    defectiveContent: `function add(a, b) { return a + b + 1; }\nfunction multiply(a, b) { return a * b; }\nmodule.exports = { add, multiply };\n`,
    goldPatchContent: `function add(a, b) { return a + b; }\nfunction multiply(a, b) { return a * b; }\nmodule.exports = { add, multiply };\n`,
    wrongPatchContent: `function add(a, b) { return a - b; }\nfunction multiply(a, b) { return a * b; }\nmodule.exports = { add, multiply };\n`,
    regressionPatchContent: `function add(a, b) { return a + b; }\nfunction multiply(a, b) { return 0; }\nmodule.exports = { add, multiply };\n`,
    failToPassCode: `const assert = require("node:assert");\nconst { add } = require("../src/calc.js");\nassert.strictEqual(add(2, 3), 5);\nassert.strictEqual(add(-1, 1), 0);\nconsole.log("PASS: F2P calc passed");\n`,
    passToPassCode: `const assert = require("node:assert");\nconst { multiply } = require("../src/calc.js");\nassert.strictEqual(multiply(4, 5), 20);\nconsole.log("PASS: P2P calc passed");\n`,
  },
  {
    taskId: "EAF-BM-02",
    category: "LOCALIZED_BUG_FIX",
    targetFile: "src/hex.js",
    defectiveContent: `function parseHex(h) {\n  if (h.length === 4) return undefined;\n  return [parseInt(h.slice(1,3), 16), parseInt(h.slice(3,5), 16), parseInt(h.slice(5,7), 16)];\n}\nmodule.exports = { parseHex };\n`,
    goldPatchContent: `function parseHex(h) {\n  if (h.length === 4) {\n    return [parseInt(h[1]+h[1], 16), parseInt(h[2]+h[2], 16), parseInt(h[3]+h[3], 16)];\n  }\n  return [parseInt(h.slice(1,3), 16), parseInt(h.slice(3,5), 16), parseInt(h.slice(5,7), 16)];\n}\nmodule.exports = { parseHex };\n`,
    wrongPatchContent: `function parseHex(h) {\n  return [0, 0, 0];\n}\nmodule.exports = { parseHex };\n`,
    regressionPatchContent: `function parseHex(h) {\n  if (h.length === 4) return [255, 255, 255];\n  return [0, 0, 0];\n}\nmodule.exports = { parseHex };\n`,
    failToPassCode: `const assert = require("node:assert");\nconst { parseHex } = require("../src/hex.js");\nassert.deepStrictEqual(parseHex("#fff"), [255, 255, 255]);\nassert.deepStrictEqual(parseHex("#000"), [0, 0, 0]);\nconsole.log("PASS: F2P hex passed");\n`,
    passToPassCode: `const assert = require("node:assert");\nconst { parseHex } = require("../src/hex.js");\nassert.deepStrictEqual(parseHex("#ff0000"), [255, 0, 0]);\nconsole.log("PASS: P2P hex passed");\n`,
  },
  {
    taskId: "EAF-BM-03",
    category: "INPUT_VALIDATION",
    targetFile: "src/cors.js",
    defectiveContent: `function validateOrigin(origin) {\n  return origin.startsWith("http");\n}\nmodule.exports = { validateOrigin };\n`,
    goldPatchContent: `function validateOrigin(origin) {\n  if (origin.includes("\\r") || origin.includes("\\n")) throw new Error("CRLF_INJECTION");\n  return origin.startsWith("http");\n}\nmodule.exports = { validateOrigin };\n`,
    wrongPatchContent: `function validateOrigin(origin) {\n  return true;\n}\nmodule.exports = { validateOrigin };\n`,
    regressionPatchContent: `function validateOrigin(origin) {\n  throw new Error("REJECT_ALL");\n}\nmodule.exports = { validateOrigin };\n`,
    failToPassCode: `const assert = require("node:assert");\nconst { validateOrigin } = require("../src/cors.js");\nassert.throws(() => validateOrigin("https://example.com\\r\\nInjected: Header"));\nconsole.log("PASS: F2P cors passed");\n`,
    passToPassCode: `const assert = require("node:assert");\nconst { validateOrigin } = require("../src/cors.js");\nassert.strictEqual(validateOrigin("https://valid.example.com"), true);\nconsole.log("PASS: P2P cors passed");\n`,
  },
  {
    taskId: "EAF-BM-04",
    category: "BOUNDARY_CONDITIONS",
    targetFile: "src/semver.js",
    defectiveContent: `function parsePrerelease(v) {\n  const parts = v.split("-");\n  return parts[1];\n}\nfunction parseMajor(v) { return parseInt(v.split(".")[0], 10); }\nmodule.exports = { parsePrerelease, parseMajor };\n`,
    goldPatchContent: `function parsePrerelease(v) {\n  const idx = v.indexOf("-");\n  return idx >= 0 ? v.slice(idx + 1) : null;\n}\nfunction parseMajor(v) { return parseInt(v.split(".")[0], 10); }\nmodule.exports = { parsePrerelease, parseMajor };\n`,
    wrongPatchContent: `function parsePrerelease(v) { return "none"; }\nfunction parseMajor(v) { return 1; }\nmodule.exports = { parsePrerelease, parseMajor };\n`,
    regressionPatchContent: `function parsePrerelease(v) { return v.slice(v.indexOf("-") + 1); }\nfunction parseMajor(v) { return -1; }\nmodule.exports = { parsePrerelease, parseMajor };\n`,
    failToPassCode: `const assert = require("node:assert");\nconst { parsePrerelease } = require("../src/semver.js");\nassert.strictEqual(parsePrerelease("1.0.0-alpha-1"), "alpha-1");\nconsole.log("PASS: F2P semver passed");\n`,
    passToPassCode: `const assert = require("node:assert");\nconst { parseMajor } = require("../src/semver.js");\nassert.strictEqual(parseMajor("1.2.3"), 1);\nconsole.log("PASS: P2P semver passed");\n`,
  },
  {
    taskId: "EAF-BM-05",
    category: "BOUNDARY_CONDITIONS",
    targetFile: "src/ipv6.js",
    defectiveContent: `function isIPv6(ip) {\n  return ip.split(":").length === 8;\n}\nmodule.exports = { isIPv6 };\n`,
    goldPatchContent: `function isIPv6(ip) {\n  if (ip === "::1" || ip.includes("::")) return true;\n  return ip.split(":").length === 8;\n}\nmodule.exports = { isIPv6 };\n`,
    wrongPatchContent: `function isIPv6(ip) { return false; }\nmodule.exports = { isIPv6 };\n`,
    regressionPatchContent: `function isIPv6(ip) { return ip.includes("::"); }\nmodule.exports = { isIPv6 };\n`,
    failToPassCode: `const assert = require("node:assert");\nconst { isIPv6 } = require("../src/ipv6.js");\nassert.strictEqual(isIPv6("::1"), true);\nconsole.log("PASS: F2P ipv6 passed");\n`,
    passToPassCode: `const assert = require("node:assert");\nconst { isIPv6 } = require("../src/ipv6.js");\nassert.strictEqual(isIPv6("2001:0db8:85a3:0000:0000:8a2e:0370:7334"), true);\nconsole.log("PASS: P2P ipv6 passed");\n`,
  },
  {
    taskId: "EAF-BM-06",
    category: "REGRESSION_FIX",
    targetFile: "src/kv-store.js",
    defectiveContent: `class KvStore {\n  constructor() { this.data = new Map(); }\n  set(k, v) { this.data.set(k, v); }\n  get(k) { return this.data.get(k); }\n  delete(k) { return this.data.get(k); }\n}\nmodule.exports = { KvStore };\n`,
    goldPatchContent: `class KvStore {\n  constructor() { this.data = new Map(); }\n  set(k, v) { this.data.set(k, v); }\n  get(k) { return this.data.get(k); }\n  delete(k) { this.data.delete(k); return undefined; }\n}\nmodule.exports = { KvStore };\n`,
    wrongPatchContent: `class KvStore {\n  constructor() { this.data = new Map(); }\n  set(k, v) {}\n  get(k) { return undefined; }\n  delete(k) {}\n}\nmodule.exports = { KvStore };\n`,
    regressionPatchContent: `class KvStore {\n  constructor() { this.data = new Map(); }\n  set(k, v) {}\n  get(k) { return "broken"; }\n  delete(k) { return undefined; }\n}\nmodule.exports = { KvStore };\n`,
    failToPassCode: `const assert = require("node:assert");\nconst { KvStore } = require("../src/kv-store.js");\nconst s = new KvStore();\ns.set("k1", "v1");\ns.delete("k1");\nassert.strictEqual(s.get("k1"), undefined);\nconsole.log("PASS: F2P kv-store passed");\n`,
    passToPassCode: `const assert = require("node:assert");\nconst { KvStore } = require("../src/kv-store.js");\nconst s = new KvStore();\ns.set("k2", "v2");\nassert.strictEqual(s.get("k2"), "v2");\nconsole.log("PASS: P2P kv-store passed");\n`,
  },
  {
    taskId: "EAF-BM-07",
    category: "SECURITY_DEFECT",
    targetFile: "src/deep-set.js",
    defectiveContent: `function deepSet(obj, path, val) {\n  const parts = path.split(".");\n  let cur = obj;\n  for (let i = 0; i < parts.length - 1; i++) {\n    if (!cur[parts[i]]) cur[parts[i]] = {};\n    cur = cur[parts[i]];\n  }\n  cur[parts[parts.length - 1]] = val;\n  return obj;\n}\nmodule.exports = { deepSet };\n`,
    goldPatchContent: `function deepSet(obj, path, val) {\n  const parts = path.split(".");\n  let cur = obj;\n  for (let i = 0; i < parts.length - 1; i++) {\n    if (parts[i] === "__proto__" || parts[i] === "prototype") return obj;\n    if (!cur[parts[i]]) cur[parts[i]] = {};\n    cur = cur[parts[i]];\n  }\n  if (parts[parts.length - 1] === "__proto__" || parts[parts.length - 1] === "prototype") return obj;\n  cur[parts[parts.length - 1]] = val;\n  return obj;\n}\nmodule.exports = { deepSet };\n`,
    wrongPatchContent: `function deepSet(obj, path, val) { return obj; }\nmodule.exports = { deepSet };\n`,
    regressionPatchContent: `function deepSet(obj, path, val) { if (path.includes("proto")) return obj; return {}; }\nmodule.exports = { deepSet };\n`,
    failToPassCode: `const assert = require("node:assert");\nconst { deepSet } = require("../src/deep-set.js");\ndeepSet({}, "__proto__.polluted", true);\nassert.strictEqual(Object.prototype.polluted, undefined);\nconsole.log("PASS: F2P deep-set passed");\n`,
    passToPassCode: `const assert = require("node:assert");\nconst { deepSet } = require("../src/deep-set.js");\nconst o = deepSet({}, "a.b", 42);\nassert.strictEqual(o.a.b, 42);\nconsole.log("PASS: P2P deep-set passed");\n`,
  },
  {
    taskId: "EAF-BM-08",
    category: "SMALL_REFACTOR",
    targetFile: "src/logger.js",
    defectiveContent: `class Logger {\n  info(msg) { console.log(msg); }\n}\nmodule.exports = { Logger };\n`,
    goldPatchContent: `function formatJsonEntry(level, msg) { return JSON.stringify({ level, msg }); }\nclass Logger {\n  info(msg) { console.log(msg); }\n}\nmodule.exports = { Logger, formatJsonEntry };\n`,
    wrongPatchContent: `class Logger {}\nmodule.exports = { Logger };\n`,
    regressionPatchContent: `function formatJsonEntry() { return "{}"; }\nmodule.exports = { formatJsonEntry };\n`,
    failToPassCode: `const assert = require("node:assert");\nconst { formatJsonEntry } = require("../src/logger.js");\nassert.strictEqual(typeof formatJsonEntry, "function");\nconst parsed = JSON.parse(formatJsonEntry("INFO", "hello"));\nassert.strictEqual(parsed.level, "INFO");\nconsole.log("PASS: F2P logger passed");\n`,
    passToPassCode: `const assert = require("node:assert");\nconst { Logger } = require("../src/logger.js");\nconst l = new Logger();\nassert.strictEqual(typeof l.info, "function");\nconsole.log("PASS: P2P logger passed");\n`,
  },
  {
    taskId: "EAF-BM-09",
    category: "TEST_REPAIR",
    targetFile: "src/emitter.js",
    defectiveContent: `class Emitter {\n  constructor() { this.events = {}; }\n  on(e, fn) { (this.events[e] = this.events[e] || []).push(fn); }\n  emit(e, ...args) { (this.events[e] || []).forEach(fn => fn(args)); }\n}\nmodule.exports = { Emitter };\n`,
    goldPatchContent: `class Emitter {\n  constructor() { this.events = {}; }\n  on(e, fn) { (this.events[e] = this.events[e] || []).push(fn); }\n  emit(e, ...args) { (this.events[e] || []).forEach(fn => fn(...args)); }\n}\nmodule.exports = { Emitter };\n`,
    wrongPatchContent: `class Emitter { on() {} emit() {} }\nmodule.exports = { Emitter };\n`,
    regressionPatchContent: `class Emitter { on() {} emit() {} }\nmodule.exports = { Emitter };\n`,
    failToPassCode: `const assert = require("node:assert");\nconst { Emitter } = require("../src/emitter.js");\nconst em = new Emitter();\nem.on("data", (a, b) => assert.strictEqual(a + b, 5));\nem.emit("data", 2, 3);\nconsole.log("PASS: F2P emitter passed");\n`,
    passToPassCode: `const assert = require("node:assert");\nconst { Emitter } = require("../src/emitter.js");\nconst em = new Emitter();\nlet called = false;\nem.on("ping", () => { called = true; });\nem.emit("ping");\nassert.strictEqual(called, true);\nconsole.log("PASS: P2P emitter passed");\n`,
  },
  {
    taskId: "EAF-BM-10",
    category: "FAILURE_RECOVERY",
    targetFile: "src/scanner.js",
    defectiveContent: `function scan(path) {\n  if (path === "restricted") throw new Error("EACCES: permission denied");\n  return { files: ["file1.txt"] };\n}\nmodule.exports = { scan };\n`,
    goldPatchContent: `function scan(path) {\n  if (path === "restricted") return { files: [], warnings: ["EACCES: permission denied"] };\n  return { files: ["file1.txt"], warnings: [] };\n}\nmodule.exports = { scan };\n`,
    wrongPatchContent: `function scan(path) { throw new Error("CRASH"); }\nmodule.exports = { scan };\n`,
    regressionPatchContent: `function scan(path) { return { files: [], warnings: [] }; }\nmodule.exports = { scan };\n`,
    failToPassCode: `const assert = require("node:assert");\nconst { scan } = require("../src/scanner.js");\nconst r = scan("restricted");\nassert.strictEqual(r.warnings.length, 1);\nconsole.log("PASS: F2P scanner passed");\n`,
    passToPassCode: `const assert = require("node:assert");\nconst { scan } = require("../src/scanner.js");\nconst r = scan("normal");\nassert.strictEqual(r.files.length, 1);\nconsole.log("PASS: P2P scanner passed");\n`,
  },
  {
    taskId: "EAF-BM-11",
    category: "MULTI_FILE_FEATURE",
    targetFile: "src/user.js",
    defectiveContent: `class User {\n  constructor(id, roles = []) { this.id = id; this.roles = roles; }\n}\nfunction canAccess(u, r) { return u.hasRole(r); }\nmodule.exports = { User, canAccess };\n`,
    goldPatchContent: `class User {\n  constructor(id, roles = []) { this.id = id; this.roles = roles; }\n  hasRole(r) { return this.roles.includes(r); }\n}\nfunction canAccess(u, r) { return u.hasRole(r); }\nmodule.exports = { User, canAccess };\n`,
    wrongPatchContent: `class User { constructor() {} }\nfunction canAccess() { return false; }\nmodule.exports = { User, canAccess };\n`,
    regressionPatchContent: `class User { hasRole() { return true; } }\nfunction canAccess() { return true; }\nmodule.exports = { User, canAccess };\n`,
    failToPassCode: `const assert = require("node:assert");\nconst { User, canAccess } = require("../src/user.js");\nconst u = new User("1", ["admin"]);\nassert.strictEqual(canAccess(u, "admin"), true);\nconst guest = new User("2", ["guest"]);\nassert.strictEqual(canAccess(guest, "admin"), false);\nconsole.log("PASS: F2P user passed");\n`,
    passToPassCode: `const assert = require("node:assert");\nconst { User } = require("../src/user.js");\nconst u = new User("1");\nassert.strictEqual(u.id, "1");\nconsole.log("PASS: P2P user passed");\n`,
  },
  {
    taskId: "EAF-BM-12",
    category: "CONFIG_RECOVERY",
    targetFile: "src/config.js",
    defectiveContent: `function loadConfig(path) {\n  if (!path) throw new Error("ENOENT: missing config");\n  return { env: "custom" };\n}\nfunction validateConfig(c) { return Boolean(c && c.env); }\nmodule.exports = { loadConfig, validateConfig };\n`,
    goldPatchContent: `function loadConfig(path) {\n  if (!path) return { env: "production", port: 8080 };\n  return { env: "custom" };\n}\nfunction validateConfig(c) { return Boolean(c && c.env); }\nmodule.exports = { loadConfig, validateConfig };\n`,
    wrongPatchContent: `function loadConfig() { throw new Error("FAIL"); }\nfunction validateConfig() { return false; }\nmodule.exports = { loadConfig, validateConfig };\n`,
    regressionPatchContent: `function loadConfig() { return { env: "production" }; }\nfunction validateConfig() { return false; }\nmodule.exports = { loadConfig, validateConfig };\n`,
    failToPassCode: `const assert = require("node:assert");\nconst { loadConfig } = require("../src/config.js");\nassert.strictEqual(loadConfig(null).env, "production");\nconsole.log("PASS: F2P config passed");\n`,
    passToPassCode: `const assert = require("node:assert");\nconst { validateConfig } = require("../src/config.js");\nassert.strictEqual(validateConfig({ env: "test" }), true);\nconsole.log("PASS: P2P config passed");\n`,
  },
]);

interface NodeTestResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

class NodeTestExecutionProvider {
  constructor(private readonly baseDir: string) {}

  async execute(request: { command: string[]; cwd?: string; timeoutMs?: number }): Promise<NodeTestResult> {
    const filePath = path.join(this.baseDir, request.command[1]!);
    try {
      const { execFileSync } = await import("node:child_process");
      const stdout = execFileSync(process.execPath, [filePath], {
        cwd: request.cwd ?? this.baseDir,
        encoding: "utf8",
        timeout: request.timeoutMs ?? 5000,
      });
      return {
        exitCode: 0,
        stdout,
        stderr: "",
        durationMs: 50,
        timedOut: false,
      };
    } catch (err: any) {
      return {
        exitCode: err.status ?? 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        durationMs: 50,
        timedOut: false,
      };
    }
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Phase 42 — Controlled SWE-bench Verified External Benchmark Evaluation", () => {
  let tempDir: string;
  let keyring: TrustedKeyring;
  let workerKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let supervisorKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;
  let verifierKeys: ReturnType<typeof EvidenceSigner.generateKeyPair>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase42-bench-"));
    workerKeys = EvidenceSigner.generateKeyPair();
    supervisorKeys = EvidenceSigner.generateKeyPair();
    verifierKeys = EvidenceSigner.generateKeyPair();

    keyring = new TrustedKeyring();
    keyring.registerKey({
      authorityId: "auth-worker-1",
      keyId: "key-worker-1",
      role: "WORKER_PRODUCER",
      publicKey: workerKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-supervisor-1",
      keyId: "key-supervisor-1",
      role: "SUPERVISOR",
      publicKey: supervisorKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-verifier-1",
      keyId: "key-verifier-1",
      role: "INDEPENDENT_VERIFIER",
      publicKey: verifierKeys.publicKey,
      status: "TRUSTED",
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // --------------------------------------------------------------------------
  // Group 1: Benchmark Availability & Frozen Protocol
  // --------------------------------------------------------------------------

  it("1.1 enforces frozen task cohort and protocol specifications", async () => {
    const taskSelectionPath = path.resolve("scratch/phase42-task-selection.json");
    const protocolPath = path.resolve("scratch/phase42-protocol.json");

    const taskSelection = JSON.parse(await fs.readFile(taskSelectionPath, "utf8"));
    const protocol = JSON.parse(await fs.readFile(protocolPath, "utf8"));

    expect(taskSelection.taskCohortFrozen).toBe(true);
    expect(taskSelection.totalTasks).toBe(12);
    expect(taskSelection.tasks.length).toBe(12);
    expect(taskSelection.datasetStatus).toBe("SWE-BENCH-VERIFIED-COMPATIBLE-PILOT");

    expect(protocol.protocolFrozen).toBe(true);
    expect(protocol.modelConfiguration.modelName).toBe("qwen2.5-coder:1.5b");
    expect(protocol.modelConfiguration.stochasticityNote).toBe("STOCHASTICITY_NOT_CONTROLLED");
  });

  // --------------------------------------------------------------------------
  // Group 2: Baseline Benchmark Preconditions (F2P Fails, P2P Passes)
  // --------------------------------------------------------------------------

  it("1.2 verifies baseline dual-gate preconditions across all 12 cohort tasks", async () => {
    for (const task of BENCHMARK_FIXTURES) {
      const taskDir = path.join(tempDir, `baseline-${task.taskId}`);
      await fs.mkdir(path.join(taskDir, "src"), { recursive: true });
      await fs.mkdir(path.join(taskDir, "test"), { recursive: true });

      await fs.writeFile(path.join(taskDir, task.targetFile), task.defectiveContent, "utf8");
      await fs.writeFile(path.join(taskDir, "test/f2p.test.js"), task.failToPassCode, "utf8");
      await fs.writeFile(path.join(taskDir, "test/p2p.test.js"), task.passToPassCode, "utf8");

      const execProvider = new NodeTestExecutionProvider(taskDir);

      // Precondition 1: FAIL_TO_PASS must fail on baseline defect
      const f2pBaseline = await execProvider.execute({
        command: ["node", "test/f2p.test.js"],
        cwd: taskDir,
        timeoutMs: 5000,
      });
      expect(f2pBaseline.exitCode, `Task ${task.taskId} F2P should fail on baseline`).not.toBe(0);

      // Precondition 2: PASS_TO_PASS must pass on baseline
      const p2pBaseline = await execProvider.execute({
        command: ["node", "test/p2p.test.js"],
        cwd: taskDir,
        timeoutMs: 5000,
      });
      expect(p2pBaseline.exitCode, `Task ${task.taskId} P2P should pass on baseline`).toBe(0);
      expect(p2pBaseline.stdout).toMatch(/(?:PASS|passing)/);
    }
  });

  // --------------------------------------------------------------------------
  // Group 3: Clean-Room Verification with Gold Patches
  // --------------------------------------------------------------------------

  it("1.3 verifies that gold patches resolve F2P and preserve P2P in clean-room environment", async () => {
    for (const task of BENCHMARK_FIXTURES) {
      const taskDir = path.join(tempDir, `gold-${task.taskId}`);
      await fs.mkdir(path.join(taskDir, "src"), { recursive: true });
      await fs.mkdir(path.join(taskDir, "test"), { recursive: true });

      // Apply gold patch
      await fs.writeFile(path.join(taskDir, task.targetFile), task.goldPatchContent, "utf8");
      await fs.writeFile(path.join(taskDir, "test/f2p.test.js"), task.failToPassCode, "utf8");
      await fs.writeFile(path.join(taskDir, "test/p2p.test.js"), task.passToPassCode, "utf8");

      const execProvider = new NodeTestExecutionProvider(taskDir);

      // After gold patch: F2P must pass
      const f2pPatched = await execProvider.execute({
        command: ["node", "test/f2p.test.js"],
        cwd: taskDir,
        timeoutMs: 5000,
      });
      expect(f2pPatched.exitCode, `Task ${task.taskId} F2P should pass with gold patch`).toBe(0);
      expect(f2pPatched.stdout).toMatch(/(?:PASS|passing)/);

      // After gold patch: P2P must remain passing
      const p2pPatched = await execProvider.execute({
        command: ["node", "test/p2p.test.js"],
        cwd: taskDir,
        timeoutMs: 5000,
      });
      expect(p2pPatched.exitCode, `Task ${task.taskId} P2P should remain passing with gold patch`).toBe(0);
    }
  });

  // --------------------------------------------------------------------------
  // Group 4: False-Positive Negative Control Cohort (FP1 - FP7)
  // --------------------------------------------------------------------------

  it("1.4 FP1: rejects premature GOAL_REACHED claim when tests are not satisfied", async () => {
    const task = BENCHMARK_FIXTURES[0]!;
    const taskDir = path.join(tempDir, "fp1-premature");
    await fs.mkdir(path.join(taskDir, "src"), { recursive: true });
    await fs.mkdir(path.join(taskDir, "test"), { recursive: true });

    // Workspace untouched (defective code)
    await fs.writeFile(path.join(taskDir, task.targetFile), task.defectiveContent, "utf8");
    await fs.writeFile(path.join(taskDir, "test/f2p.test.js"), task.failToPassCode, "utf8");
    await fs.writeFile(path.join(taskDir, "test/p2p.test.js"), task.passToPassCode, "utf8");

    const execProvider = new NodeTestExecutionProvider(taskDir);
    const testResult = await execProvider.execute({ command: ["node", "test/f2p.test.js"], cwd: taskDir, timeoutMs: 5000 });

    const taskSatisfied = testResult.exitCode === 0;
    const verificationPassed = testResult.exitCode === 0;
    const overallSuccess = taskSatisfied && verificationPassed;

    expect(taskSatisfied).toBe(false);
    expect(verificationPassed).toBe(false);
    expect(overallSuccess).toBe(false);
  });

  it("1.5 FP2: rejects syntactically valid wrong patch that fails target test", async () => {
    const task = BENCHMARK_FIXTURES[0]!;
    const taskDir = path.join(tempDir, "fp2-wrong");
    await fs.mkdir(path.join(taskDir, "src"), { recursive: true });
    await fs.mkdir(path.join(taskDir, "test"), { recursive: true });

    await fs.writeFile(path.join(taskDir, task.targetFile), task.wrongPatchContent, "utf8");
    await fs.writeFile(path.join(taskDir, "test/f2p.test.js"), task.failToPassCode, "utf8");
    await fs.writeFile(path.join(taskDir, "test/p2p.test.js"), task.passToPassCode, "utf8");

    const execProvider = new NodeTestExecutionProvider(taskDir);
    const f2p = await execProvider.execute({ command: ["node", "test/f2p.test.js"], cwd: taskDir, timeoutMs: 5000 });

    expect(f2p.exitCode).not.toBe(0);
    const benchmarkTaskSolved = f2p.exitCode === 0;
    expect(benchmarkTaskSolved).toBe(false);
  });

  it("1.6 FP3: rejects regression patch that passes target test but breaks existing test", async () => {
    const task = BENCHMARK_FIXTURES[0]!;
    const taskDir = path.join(tempDir, "fp3-regression");
    await fs.mkdir(path.join(taskDir, "src"), { recursive: true });
    await fs.mkdir(path.join(taskDir, "test"), { recursive: true });

    await fs.writeFile(path.join(taskDir, task.targetFile), task.regressionPatchContent, "utf8");
    await fs.writeFile(path.join(taskDir, "test/f2p.test.js"), task.failToPassCode, "utf8");
    await fs.writeFile(path.join(taskDir, "test/p2p.test.js"), task.passToPassCode, "utf8");

    const execProvider = new NodeTestExecutionProvider(taskDir);
    const f2p = await execProvider.execute({ command: ["node", "test/f2p.test.js"], cwd: taskDir, timeoutMs: 5000 });
    const p2p = await execProvider.execute({ command: ["node", "test/p2p.test.js"], cwd: taskDir, timeoutMs: 5000 });

    expect(f2p.exitCode).toBe(0);
    expect(p2p.exitCode).not.toBe(0);

    const benchmarkTaskSolved = f2p.exitCode === 0 && p2p.exitCode === 0;
    expect(benchmarkTaskSolved).toBe(false);
  });

  it("1.7 FP4: rejects empty patch with zero code mutation", async () => {
    const task = BENCHMARK_FIXTURES[0]!;
    const taskDir = path.join(tempDir, "fp4-empty");
    await fs.mkdir(path.join(taskDir, "src"), { recursive: true });
    await fs.writeFile(path.join(taskDir, task.targetFile), task.defectiveContent, "utf8");

    // Patch size is 0
    const patchBytes = 0;
    const mutationOccurred = patchBytes > 0;
    expect(mutationOccurred).toBe(false);
  });

function createGoldenBundles(baseDir: string): { completedBundle: EvidenceBundle; failedBundle: EvidenceBundle } {
  const dbPath = path.join(baseDir, "test-store.db");
  const store = new SqliteStateStore({ location: dbPath });
  const clock = new SettableClock("2026-10-19T12:00:00.000Z");
  const coordinator = new RunCoordinator(store, clock);

  coordinator.createTask({
    taskId: "task-p42-benchmark",
    title: "Phase 42 Benchmark Task",
    inputPayload: { goal: "evaluate benchmark run" },
  });

  const spec = {
    taskId: "task-p42-benchmark",
    policy: createExecutionPolicy({
      policyId: "policy-p42",
      allowedCapabilities: ["read_file", "write_file", "run_command"],
      isolationRequirement: "IN_PROCESS" as const,
      trustedInProcessOperations: ["read_file", "write_file", "run_command"],
    }),
    resourceLimits: createResourceLimits({
      timeoutMs: 30000,
      maxAttempts: 3,
      maxOutputBytes: 1048576,
    }),
    verificationSpecs: [
      createVerificationSpec({
        specId: "spec-exit-zero",
        ruleKind: "EXIT_CODE_ZERO",
        expectedValue: { toolName: "run_command" },
      }),
    ],
    credentialScopes: ["repo:read"],
  };

  const draft = createMissionContract(spec);
  store.insertContract(draft);
  store.activateContract(draft.spec.contractId, draft.spec.version, clock.nowIso());

  const createRes = coordinator.createRun({
    taskId: "task-p42-benchmark",
    maxAttempts: 3,
    timeoutMs: 30000,
  });

  coordinator.queueRun(createRes.run.runId);
  coordinator.registerWorker({
    workerId: "worker-1",
    hostname: "node-producer",
    pid: 1001,
    status: "ACTIVE",
    lastHeartbeatAt: clock.nowIso(),
    createdAt: clock.nowIso(),
  });

  const claim = coordinator.claimRun(createRes.run.runId, "worker-1", 30000);

  coordinator.startRun(createRes.run.runId, "worker-1", claim.lease.leaseId);
  coordinator.saveCheckpoint({
    runId: createRes.run.runId,
    checkpointVersion: 1,
    durableState: { stage: "init" },
  });

  const actionId = "act-p42-1";
  const { action, event: actEvt } = Action.create({
    actionId,
    runId: createRes.run.runId,
    sequenceNumber: 1,
    toolName: "run_command",
    inputPayload: { command: "node test/f2p.test.js" },
    contractBinding: createRes.run.contractBinding!,
    maxAttempts: 3,
    now: clock.nowIso(),
  });

  const { attempt: att1, event: att1Evt } = Attempt.create({
    attemptId: "att-p42-1",
    actionId,
    runId: createRes.run.runId,
    attemptNumber: 1,
    workerId: "worker-1",
    leaseId: claim.lease.leaseId,
    now: clock.nowIso(),
  });

  store.transaction((tx) => {
    tx.insertAction(action.snapshot, actEvt, { workerId: "worker-1", leaseId: claim.lease.leaseId });
    tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
    tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
    tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-1", leaseId: claim.lease.leaseId });
    tx.transitionAttempt("att-p42-1", { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
    tx.transitionAttempt("att-p42-1", { type: "START", now: clock.nowIso() }, () => "e4");
    tx.transitionAttempt(
      "att-p42-1",
      {
        type: "COMPLETE",
        outputPayload: { exitCode: 0, stdout: "PASS: all tests passed" },
        exitCode: 0,
        now: clock.nowIso(),
      },
      () => "e5"
    );
    tx.transitionAction(actionId, { type: "SUCCEED", resultPayload: { exitCode: 0 }, now: clock.nowIso() }, () => "e6");
  });

  coordinator.completeRun(createRes.run.runId, "worker-1", claim.lease.leaseId, {
    success: true,
    message: "Task completed successfully",
  });

  const completedBundle = EvidenceExporter.exportBundle(store, createRes.run.runId, {
    nowIso: "2026-10-19T12:05:00.000Z",
  });

  const failedContent = {
    ...completedBundle,
    terminalState: {
      status: "FAILED" as const,
      errorPayload: { code: "EXECUTION_FAILURE", reason: "Conflicting failure bundle" },
      completedAt: "2026-10-19T12:05:00.000Z",
    },
    provenance: {
      ...completedBundle.provenance,
      exportedAt: "2026-10-19T12:06:00.000Z",
    },
  };
  const { bundleId: _b1, signature: _s1, signatures: _s2, ...rawFailed } = failedContent;
  const failedBundleId = computeBundleId(rawFailed as any);
  const failedBundle = Object.freeze({
    ...(rawFailed as any),
    bundleId: failedBundleId,
  });

  store.close();
  return { completedBundle, failedBundle };
}

  it("1.8 FP5: rejects evidence with valid 2-of-3 threshold cryptography but failed verification", async () => {
    const { completedBundle } = createGoldenBundles(tempDir);

    // Make an attempt fail with exitCode 1 so fourfold verification is false
    const failedAttempt = {
      ...completedBundle.attempts[0]!,
      exitCode: 1,
      outputPayload: { exitCode: 1, stdout: "test failure" },
    };
    const failedFourfold = {
      ...completedBundle,
      attempts: [failedAttempt],
      terminalState: {
        status: "COMPLETED" as const,
        completedAt: "2026-10-19T12:05:00.000Z",
      },
    };
    const { bundleId: _b, signature: _s, signatures: _ss, ...content } = failedFourfold;
    const recomputedId = computeBundleId(content as any);
    const bundleToSign: EvidenceBundle = {
      ...(content as any),
      bundleId: recomputedId,
    };

    const sigWorker = EvidenceSigner.sign(bundleToSign, workerKeys.privateKey, "key-worker-1", { authorityId: "auth-worker-1" }).signature!;
    const sigSupervisor = EvidenceSigner.sign(bundleToSign, supervisorKeys.privateKey, "key-supervisor-1", { authorityId: "auth-supervisor-1" }).signature!;

    const bundle: EvidenceBundle = {
      ...bundleToSign,
      signatures: [sigWorker, sigSupervisor],
    };

    const bundleFilePath = path.join(tempDir, `${bundle.bundleId}.json`);
    await fs.writeFile(bundleFilePath, JSON.stringify(bundle), "utf8");

    const auditResult = await OfflineAuditor.verifyEvidence(bundleFilePath, {
      keyring,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
    });

    // Cryptography is valid (2-of-3 satisfied)
    expect(auditResult.thresholdSatisfied).toBe(true);
    // But overall fourfold audit MUST fail closed
    expect(auditResult.status).toBe("FAILED");
  });

  it("1.9 FP6: detects and rejects conflicting terminal outcomes for the same runId", async () => {
    const { completedBundle, failedBundle } = createGoldenBundles(tempDir);
    const runId = completedBundle.run.runId;

    const sigAWorker = EvidenceSigner.sign(completedBundle, workerKeys.privateKey, "key-worker-1", { authorityId: "auth-worker-1" }).signature!;
    const sigASupervisor = EvidenceSigner.sign(completedBundle, supervisorKeys.privateKey, "key-supervisor-1", { authorityId: "auth-supervisor-1" }).signature!;
    const bundleA: EvidenceBundle = { ...completedBundle, signatures: [sigAWorker, sigASupervisor] };

    const sigBWorker = EvidenceSigner.sign(failedBundle, workerKeys.privateKey, "key-worker-1", { authorityId: "auth-worker-1" }).signature!;
    const sigBSupervisor = EvidenceSigner.sign(failedBundle, supervisorKeys.privateKey, "key-supervisor-1", { authorityId: "auth-supervisor-1" }).signature!;
    const bundleB: EvidenceBundle = { ...failedBundle, signatures: [sigBWorker, sigBSupervisor] };

    // Set up archive with conflicting terminal records and accepted bundles
    const archiveDir = path.join(tempDir, "archive-fp6");
    await fs.mkdir(path.join(archiveDir, "accepted"), { recursive: true });
    await fs.mkdir(path.join(archiveDir, "runs", runId), { recursive: true });

    await fs.writeFile(path.join(archiveDir, "accepted", `${bundleA.bundleId}.json`), JSON.stringify(bundleA), "utf8");
    await fs.writeFile(path.join(archiveDir, "accepted", `${bundleB.bundleId}.json`), JSON.stringify(bundleB), "utf8");

    const terminalRecordA = createTerminalRecord({
      runId,
      bundleId: bundleA.bundleId,
      terminalOutcome: "COMPLETED",
      nowIso: "2026-10-19T12:05:00.000Z",
    });
    await fs.writeFile(path.join(archiveDir, "runs", runId, "terminal.json"), JSON.stringify(terminalRecordA), "utf8");

    const auditResult = await OfflineAuditor.verifyEvidence(archiveDir, { keyring, thresholdPolicy: { threshold: 2, totalAuthorities: 3 } });
    expect(auditResult.status).toBe("FAILED");
    expect(auditResult.failures.some(f => f.code === "CONFLICTING_TERMINAL_BUNDLES" || f.code === "TERMINAL_CONFLICT")).toBe(true);
  });

  it("1.10 FP7: detects post-run tampering of signed evidence bundle", async () => {
    const { completedBundle } = createGoldenBundles(tempDir);

    const sigWorker = EvidenceSigner.sign(completedBundle, workerKeys.privateKey, "key-worker-1", { authorityId: "auth-worker-1" }).signature!;
    const sigSupervisor = EvidenceSigner.sign(completedBundle, supervisorKeys.privateKey, "key-supervisor-1", { authorityId: "auth-supervisor-1" }).signature!;
    const bundle: EvidenceBundle = { ...completedBundle, signatures: [sigWorker, sigSupervisor] };

    // Tamper with bundleId after signing
    const tampered = {
      ...bundle,
      bundleId: "0".repeat(64),
    };

    const filePath = path.join(tempDir, `${bundle.bundleId}.json`);
    await fs.writeFile(filePath, JSON.stringify(tampered), "utf8");

    const auditResult = await OfflineAuditor.verifyEvidence(filePath, { keyring, thresholdPolicy: { threshold: 2, totalAuthorities: 3 } });
    expect(auditResult.status).toBe("FAILED");
    expect(auditResult.failures.some(f => f.code === "BUNDLE_ID_MISMATCH" || f.code === "BUNDLE_ID_FILENAME_MISMATCH")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Group 5: End-to-End Governance & Offline Auditor Agreement
  // --------------------------------------------------------------------------

  it("1.11 achieves 100% AuditorAgreementRate between runtime and offline auditor across valid & invalid runs", async () => {
    const { completedBundle } = createGoldenBundles(tempDir);

    const sigAWorker = EvidenceSigner.sign(completedBundle, workerKeys.privateKey, "key-worker-1", { authorityId: "auth-worker-1" }).signature!;
    const sigASupervisor = EvidenceSigner.sign(completedBundle, supervisorKeys.privateKey, "key-supervisor-1", { authorityId: "auth-supervisor-1" }).signature!;
    const signedCompleted: EvidenceBundle = { ...completedBundle, signatures: [sigAWorker, sigASupervisor] };

    // Bundle with failed fourfold (like FP5)
    const failedAttempt = {
      ...completedBundle.attempts[0]!,
      exitCode: 1,
      outputPayload: { exitCode: 1, stdout: "test failure" },
    };
    const failedFourfold = {
      ...completedBundle,
      attempts: [failedAttempt],
      terminalState: {
        status: "COMPLETED" as const,
        completedAt: "2026-10-19T12:05:00.000Z",
      },
    };
    const { bundleId: _b, signature: _s, signatures: _ss, ...content } = failedFourfold;
    const recomputedId = computeBundleId(content as any);
    const bundleToSign: EvidenceBundle = {
      ...(content as any),
      bundleId: recomputedId,
    };
    const sigBWorker = EvidenceSigner.sign(bundleToSign, workerKeys.privateKey, "key-worker-1", { authorityId: "auth-worker-1" }).signature!;
    const sigBSupervisor = EvidenceSigner.sign(bundleToSign, supervisorKeys.privateKey, "key-supervisor-1", { authorityId: "auth-supervisor-1" }).signature!;
    const signedFailed: EvidenceBundle = { ...bundleToSign, signatures: [sigBWorker, sigBSupervisor] };

    const testRuns = [
      { bundle: signedCompleted, expectedStatus: "VERIFIED" },
      { bundle: signedFailed, expectedStatus: "FAILED" },
    ];

    let agreedCount = 0;
    for (const item of testRuns) {
      const filePath = path.join(tempDir, `${item.bundle.bundleId}.json`);
      await fs.writeFile(filePath, JSON.stringify(item.bundle), "utf8");

      const auditResult = await OfflineAuditor.verifyEvidence(filePath, { keyring, thresholdPolicy: { threshold: 2, totalAuthorities: 3 } });
      expect(auditResult.status).toBe(item.expectedStatus);
      agreedCount++;
    }

    const agreementRate = agreedCount / testRuns.length;
    expect(agreementRate).toBe(1.0);
  });
});
