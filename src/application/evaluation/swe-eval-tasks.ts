/**
 * Phase 9 — Empirical SWE Evaluation Tasks for Emerald Agent Fabric.
 *
 * Establishes six deterministic, multi-file software engineering evaluation tasks (Tasks J–O)
 * designed to evaluate the frozen RuleBasedReflex controller under realistic code modification workloads:
 *
 * 1. TASK_J_BUG_FIX_A: Single-module calculator bug fix (inspect, fix operator, verify via tests).
 * 2. TASK_K_BUG_FIX_B: Multi-file parser/lexer precedence bug fix (inspect lexer/parser, fix evaluation, verify).
 * 3. TASK_L_FEATURE_ADDITION_A: Single-module string-utils feature addition (implement slugify, verify).
 * 4. TASK_M_FEATURE_ADDITION_B: Multi-file domain architecture feature (User model + UserService + exports, verify).
 * 5. TASK_N_RECOVERABLE_FAILURE: Legitimate failure recovery (initial missing configuration recovered safely).
 * 6. TASK_O_FUTILE_FAILURE_LOOP: Futile/unrecoverable task testing whether Reflex bounds repeated tool dispatches.
 *
 * Principles:
 * - Provider-independent: tasks define physical workspace fixtures and objective criteria only.
 * - CPU-first & Zero External Network: pure Node.js built-ins (node:assert), zero npm install required.
 * - Objective Ground Truth: criteria verify physical workspace evidence (files, strings, test exit codes).
 * - Immutable & Deterministically Hashed.
 */

import {
  createEvaluationTask,
  EvaluationTaskDefinition,
} from "../../domain/evaluation.js";

// ============================================================================
// Task J: Bug Fix A (Calculator Operator Bug)
// ============================================================================

export const TASK_J_BUG_FIX_A: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-swe-bug-fix-calc",
  version: 1,
  description:
    "Fix addition operator bug in calculator module. Inspect src/calc.js and test/calc.test.js, correct the bug in src/calc.js so that add(a, b) returns a + b.",
  fixture: {
    initialFiles: {
      "src/calc.js": `function add(a, b) {\n  return a - b;\n}\n\nfunction subtract(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add, subtract };\n`,
      "test/calc.test.js": `const assert = require("node:assert");\nconst { add, subtract } = require("../src/calc.js");\n\nassert.strictEqual(add(2, 3), 5, "2 + 3 should equal 5");\nassert.strictEqual(add(-1, 1), 0, "-1 + 1 should equal 0");\nassert.strictEqual(subtract(5, 3), 2, "5 - 3 should equal 2");\nconsole.log("PASS: calculator tests passed");\n`,
    },
  },
  mission: {
    requiredCapabilities: [
      "workspace.file.read",
      "workspace.file.write",
      "workspace.code.search",
    ],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 3,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "calc-file-exists",
      kind: "FILE_EXISTS",
      path: "src/calc.js",
      description: "Calculator source file must exist",
    },
    {
      criterionId: "calc-has-correct-operator",
      kind: "TEXT_CONTAINS",
      path: "src/calc.js",
      expectedSubstring: "return a + b",
      description: "Calculator must contain addition operator implementation",
    },
    {
      criterionId: "calc-tests-pass",
      kind: "COMMAND_EXIT_CODE",
      command: ["node", "test/calc.test.js"],
      expectedExitCode: 0,
      description: "Calculator test suite must pass with exit code 0",
    },
  ],
  budget: {
    maxSteps: 8,
    maxActions: 8,
    maxWallClockMs: 60000,
    maxConsecutiveFailures: 3,
    maxProposalRejections: 3,
  },
});

// ============================================================================
// Task K: Bug Fix B (Multi-File Parser/Lexer Precedence Bug)
// ============================================================================

export const TASK_K_BUG_FIX_B: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-swe-bug-fix-parser",
  version: 1,
  description:
    "Fix multiplication evaluation bug in expression parser. Inspect src/lexer.js, src/parser.js, and test/parser.test.js. Fix parser in src/parser.js so multiplication evaluates correctly.",
  fixture: {
    initialFiles: {
      "src/lexer.js": `function tokenize(input) {\n  const tokens = [];\n  const regex = /\\s*([0-9]+|[-+*\\/])\\s*/g;\n  let match;\n  while ((match = regex.exec(input)) !== null) {\n    const val = match[1];\n    if (/^[0-9]+$/.test(val)) {\n      tokens.push({ type: "NUMBER", value: Number(val) });\n    } else {\n      tokens.push({ type: "OPERATOR", value: val });\n    }\n  }\n  return tokens;\n}\n\nmodule.exports = { tokenize };\n`,
      "src/parser.js": `const { tokenize } = require("./lexer.js");\n\nfunction parseAndEval(expr) {\n  const tokens = tokenize(expr);\n  if (tokens.length === 0) return 0;\n  let result = tokens[0].value;\n  for (let i = 1; i < tokens.length; i += 2) {\n    const op = tokens[i].value;\n    const nextVal = tokens[i + 1].value;\n    if (op === "+") result += nextVal;\n    else if (op === "-") result -= nextVal;\n    else if (op === "*") result = nextVal;\n    else if (op === "/") result = Math.floor(result / nextVal);\n  }\n  return result;\n}\n\nmodule.exports = { parseAndEval };\n`,
      "test/parser.test.js": `const assert = require("node:assert");\nconst { parseAndEval } = require("../src/parser.js");\n\nassert.strictEqual(parseAndEval("2 + 3"), 5, "2 + 3 should be 5");\nassert.strictEqual(parseAndEval("4 * 3"), 12, "4 * 3 should be 12");\nassert.strictEqual(parseAndEval("10 - 4"), 6, "10 - 4 should be 6");\nconsole.log("PASS: parser tests passed");\n`,
    },
  },
  mission: {
    requiredCapabilities: [
      "workspace.file.read",
      "workspace.file.write",
      "workspace.code.search",
    ],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 3,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "parser-file-exists",
      kind: "FILE_EXISTS",
      path: "src/parser.js",
      description: "Parser source file must exist",
    },
    {
      criterionId: "parser-multiply-fixed",
      kind: "TEXT_CONTAINS",
      path: "src/parser.js",
      expectedSubstring: "result *= nextVal",
      description: "Parser must multiply result by nextVal",
    },
    {
      criterionId: "parser-tests-pass",
      kind: "COMMAND_EXIT_CODE",
      command: ["node", "test/parser.test.js"],
      expectedExitCode: 0,
      description: "Parser test suite must pass with exit code 0",
    },
  ],
  budget: {
    maxSteps: 8,
    maxActions: 8,
    maxWallClockMs: 60000,
    maxConsecutiveFailures: 3,
    maxProposalRejections: 3,
  },
});

// ============================================================================
// Task L: Feature Addition A (String Utils Slugify)
// ============================================================================

export const TASK_L_FEATURE_ADDITION_A: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-swe-feature-string-utils",
  version: 1,
  description:
    "Implement slugify function in string utils module. Inspect src/string-utils.js and test/string-utils.test.js, add and export slugify so that slugify(str) transforms text to lowercase with hyphenated word delimiters.",
  fixture: {
    initialFiles: {
      "src/string-utils.js": `function capitalize(str) {\n  if (!str) return "";\n  return str.charAt(0).toUpperCase() + str.slice(1);\n}\n\nfunction reverse(str) {\n  return str.split("").reverse().join("");\n}\n\nmodule.exports = { capitalize, reverse };\n`,
      "test/string-utils.test.js": `const assert = require("node:assert");\nconst utils = require("../src/string-utils.js");\n\nassert.strictEqual(utils.capitalize("hello"), "Hello");\nassert.strictEqual(utils.reverse("abc"), "cba");\nassert.strictEqual(typeof utils.slugify, "function", "slugify function must be exported");\nassert.strictEqual(utils.slugify("Hello World"), "hello-world");\nassert.strictEqual(utils.slugify("Emerald Agent Fabric!"), "emerald-agent-fabric");\nconsole.log("PASS: string utils feature tests passed");\n`,
    },
  },
  mission: {
    requiredCapabilities: [
      "workspace.file.read",
      "workspace.file.write",
      "workspace.code.search",
    ],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 3,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "string-utils-exists",
      kind: "FILE_EXISTS",
      path: "src/string-utils.js",
      description: "String utils module must exist",
    },
    {
      criterionId: "string-utils-has-slugify",
      kind: "TEXT_CONTAINS",
      path: "src/string-utils.js",
      expectedSubstring: "slugify",
      description: "String utils must export slugify function",
    },
    {
      criterionId: "string-utils-tests-pass",
      kind: "COMMAND_EXIT_CODE",
      command: ["node", "test/string-utils.test.js"],
      expectedExitCode: 0,
      description: "String utils test suite must pass with exit code 0",
    },
  ],
  budget: {
    maxSteps: 8,
    maxActions: 8,
    maxWallClockMs: 60000,
    maxConsecutiveFailures: 3,
    maxProposalRejections: 3,
  },
});

// ============================================================================
// Task M: Feature Addition B (Multi-File User Model and Service)
// ============================================================================

export const TASK_M_FEATURE_ADDITION_B: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-swe-feature-multi-file",
  version: 1,
  description:
    "Add hasRole(role) method to User model in src/models/user.js, wire it into UserService in src/services/user-service.js, and export User and UserService from src/index.js.",
  fixture: {
    initialFiles: {
      "src/models/user.js": `class User {\n  constructor(id, name, roles = []) {\n    this.id = id;\n    this.name = name;\n    this.roles = roles;\n  }\n}\n\nmodule.exports = { User };\n`,
      "src/services/user-service.js": `const { User } = require("../models/user.js");\n\nclass UserService {\n  createUser(id, name, roles) {\n    return new User(id, name, roles);\n  }\n\n  canAccess(user, role) {\n    return user.hasRole(role);\n  }\n}\n\nmodule.exports = { UserService };\n`,
      "src/index.js": `const { User } = require("./models/user.js");\nconst { UserService } = require("./services/user-service.js");\n\nmodule.exports = { User, UserService };\n`,
      "test/user-service.test.js": `const assert = require("node:assert");\nconst { User, UserService } = require("../src/index.js");\n\nconst service = new UserService();\nconst admin = service.createUser("1", "Alice", ["admin", "developer"]);\nconst viewer = service.createUser("2", "Bob", ["viewer"]);\n\nassert.strictEqual(typeof admin.hasRole, "function", "User.prototype.hasRole must be a function");\nassert.strictEqual(service.canAccess(admin, "admin"), true);\nassert.strictEqual(service.canAccess(viewer, "admin"), false);\nconsole.log("PASS: multi-file user service feature tests passed");\n`,
    },
  },
  mission: {
    requiredCapabilities: [
      "workspace.file.read",
      "workspace.file.write",
      "workspace.code.search",
    ],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 3,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "user-model-exists",
      kind: "FILE_EXISTS",
      path: "src/models/user.js",
      description: "User model file must exist",
    },
    {
      criterionId: "user-model-has-role-method",
      kind: "TEXT_CONTAINS",
      path: "src/models/user.js",
      expectedSubstring: "hasRole",
      description: "User model must implement hasRole method",
    },
    {
      criterionId: "user-service-tests-pass",
      kind: "COMMAND_EXIT_CODE",
      command: ["node", "test/user-service.test.js"],
      expectedExitCode: 0,
      description: "User service test suite must pass with exit code 0",
    },
  ],
  budget: {
    maxSteps: 8,
    maxActions: 8,
    maxWallClockMs: 60000,
    maxConsecutiveFailures: 3,
    maxProposalRejections: 3,
  },
});

// ============================================================================
// Task N: Recoverable Failure (Legitimate Failure Recovery)
// ============================================================================

export const TASK_N_RECOVERABLE_FAILURE: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-swe-recoverable-failure",
  version: 1,
  description:
    "Recover from missing application configuration file. Inspect src/app.js and test/app.test.js, create the missing src/config.json with env='production' and status='ready' to pass verification.",
  fixture: {
    initialFiles: {
      "src/app.js": `const fs = require("node:fs");\nconst path = require("node:path");\n\nfunction loadConfig() {\n  const cfgPath = path.join(__dirname, "config.json");\n  if (!fs.existsSync(cfgPath)) {\n    throw new Error("CONFIG_NOT_FOUND: src/config.json is missing");\n  }\n  return JSON.parse(fs.readFileSync(cfgPath, "utf8"));\n}\n\nmodule.exports = { loadConfig };\n`,
      "test/app.test.js": `const assert = require("node:assert");\nconst { loadConfig } = require("../src/app.js");\n\nconst cfg = loadConfig();\nassert.strictEqual(cfg.env, "production");\nassert.strictEqual(cfg.status, "ready");\nconsole.log("PASS: recoverable failure configuration tests passed");\n`,
    },
  },
  mission: {
    requiredCapabilities: [
      "workspace.file.read",
      "workspace.file.write",
      "workspace.code.search",
    ],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 3,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "config-json-exists",
      kind: "FILE_EXISTS",
      path: "src/config.json",
      description: "Application configuration file src/config.json must be created",
    },
    {
      criterionId: "config-json-has-env",
      kind: "TEXT_CONTAINS",
      path: "src/config.json",
      expectedSubstring: `"env": "production"`,
      description: "src/config.json must specify production environment",
    },
    {
      criterionId: "app-tests-pass",
      kind: "COMMAND_EXIT_CODE",
      command: ["node", "test/app.test.js"],
      expectedExitCode: 0,
      description: "Application test suite must pass with exit code 0",
    },
  ],
  budget: {
    maxSteps: 8,
    maxActions: 8,
    maxWallClockMs: 60000,
    maxConsecutiveFailures: 3,
    maxProposalRejections: 3,
  },
});

// ============================================================================
// Task O: Futile Failure Loop (Unrecoverable Task)
// ============================================================================

export const TASK_O_FUTILE_FAILURE_LOOP: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-swe-futile-loop",
  version: 1,
  description:
    "Futile loop workload: agent attempts to read unresolvable resource missing/nonexistent-secret.key repeatedly. In Baseline, agent loops until budget ceiling. In Reflex, reflex.failure-loop.v1 halts wasted tool executions.",
  fixture: {
    initialFiles: {
      "src/broken.js": `// Unresolvable task: requires reading missing/nonexistent-secret.key which does not exist\nmodule.exports = { secretPath: "missing/nonexistent-secret.key" };\n`,
    },
  },
  mission: {
    requiredCapabilities: [
      "workspace.file.read",
      "workspace.file.write",
      "workspace.code.search",
    ],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 3,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "secret-key-exists",
      kind: "FILE_EXISTS",
      path: "missing/nonexistent-secret.key",
      description: "Unachievable criterion intended to fail",
    },
  ],
  budget: {
    maxSteps: 10,
    maxActions: 10,
    maxWallClockMs: 30000,
    maxConsecutiveFailures: 10,
    maxProposalRejections: 5,
  },
});

// ============================================================================
// Registry & Lookup
// ============================================================================

export const SWE_EVAL_TASKS: readonly EvaluationTaskDefinition[] = Object.freeze([
  TASK_J_BUG_FIX_A,
  TASK_K_BUG_FIX_B,
  TASK_L_FEATURE_ADDITION_A,
  TASK_M_FEATURE_ADDITION_B,
  TASK_N_RECOVERABLE_FAILURE,
  TASK_O_FUTILE_FAILURE_LOOP,
]);

export const SWE_EVAL_TASK_IDS: readonly string[] = Object.freeze(
  SWE_EVAL_TASKS.map((t) => t.taskId)
);

export function getSweEvalTask(taskId: string): EvaluationTaskDefinition {
  const task = SWE_EVAL_TASKS.find((t) => t.taskId === taskId);
  if (!task) {
    throw new Error(
      `Unknown SWE evaluation task '${taskId}'. Available: [${SWE_EVAL_TASK_IDS.join(", ")}]`
    );
  }
  return task;
}
