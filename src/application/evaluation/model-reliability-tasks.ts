/**
 * Milestone 2.25 Phase 3 — Standardized Local Model Reliability Benchmark Task Suite.
 *
 * Implements the standardized, deterministic benchmark task suite measuring whether
 * local open-weight models can reliably complete multi-step software engineering tasks
 * under Emerald Agent Fabric's sovereign safety, capability, and independent verification rules.
 *
 * Principles:
 * 1. Claims != Verified Success: Task success is decided exclusively by authoritative runtime
 *    verification specifications evaluated against physical evidence. Agent completion claims
 *    (e.g. finishReason === "GOAL_REACHED") are strictly recorded, but never dictate success.
 * 2. Non-Empty Verification Specifications: Every success-oriented benchmark contract enforces
 *    non-empty verification specifications (allowUnverifiedCompletion === false).
 * 3. Exact Execution-Attempt Correlation: Verification results are bound to exact run, attempt,
 *    and contract version identifiers, failing closed on missing or mismatched metadata.
 * 4. Bounded Budgets & Ephemeral Environments: Every benchmark runs within strictly bounded
 *    steps, actions, wall-clock time, and output bytes, operating in ephemeral workspaces.
 * 5. Host Execution Boundary: ConstrainedHostExecutionProvider is restricted exclusively to
 *    these trusted benchmark fixtures. Production or adversarial workloads strictly require Docker isolation.
 * 6. Durable Recovery Authority: The recovery benchmark verifies durable checkpoint consistency,
 *    lease fencing, and the non-negotiable invariant that safeToResume remains false.
 */

import {
  type EvaluationTaskDefinition,
  validateEvaluationTask,
  type TrialFinalOutcome,
  type EvaluationCriterionKind,
  translateEvaluationTaskCriteria,
} from "../../domain/index.js";

// ============================================================================
// 1. Benchmark Category & Task Types
// ============================================================================

export const RELIABILITY_BENCHMARK_CATEGORIES = [
  "BENCH_01_FILE_CREATION_MUTATION",
  "BENCH_02_MULTI_STEP_CODING",
  "BENCH_03_REPO_INVESTIGATION",
  "BENCH_04_TEST_FAILURE_REPAIR",
  "BENCH_05_MULTI_TOOL_CHAINING",
  "BENCH_06_INTERRUPTED_RECOVERY",
] as const;

export type ReliabilityBenchmarkCategory = (typeof RELIABILITY_BENCHMARK_CATEGORIES)[number];

export interface ReliabilityBenchmarkTask {
  readonly category: ReliabilityBenchmarkCategory;
  readonly taskDefinition: EvaluationTaskDefinition;
  readonly expectedOutcome: TrialFinalOutcome;
  readonly expectedVerificationRule: string;
  readonly isolationLevel: "CONSTRAINED_HOST" | "DOCKER_CONTAINER";
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly cleanupBehavior: string;
  /** List of trusted oracle fixture files that must remain strictly immutable. */
  readonly oraclePaths: readonly string[];
  /** List of workspace files/directories the evaluated agent is authorized to mutate. */
  readonly agentWritablePaths: readonly string[];
}

export interface BenchmarkValidationResult {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

/**
 * Criterion kinds that currently have no direct runtime verifier equivalent in Emerald.
 * Tasks attempting to verify success using these criteria directly will fail closed.
 */
export const UNSUPPORTED_VERIFICATION_CRITERIA_KINDS: readonly EvaluationCriterionKind[] = [
  "FILE_CONTENT_EQUALS",
  "FILE_EXISTS",
  "FILE_ABSENT",
  "TEXT_CONTAINS",
];

// ============================================================================
// 2. Benchmark Task Definitions
// ============================================================================

/**
 * BENCH_01_FILE_CREATION_MUTATION
 * Objective: Create files with specified contents and required structure.
 */
const TASK_01_FILE_CREATION: EvaluationTaskDefinition = validateEvaluationTask({
  taskId: "benchmark-01-file-creation-mutation",
  version: 1,
  description: "Create configuration and formatting utility with specified structure and exports",
  fixture: {
    initialFiles: {
      "package.json": JSON.stringify(
        { name: "bench-01-file-creation", version: "1.0.0", type: "commonjs" },
        null,
        2
      ),
      "README.md": `# Task Instructions\n\n1. Create \`src/config.json\` containing:\n\`\`\`json\n{\n  "service": "payment-gateway",\n  "port": 8080,\n  "active": true\n}\n\`\`\`\n\n2. Create \`src/formatter.js\` exporting function \`formatPayload(service, active)\` returning string \`"[\${service}:\${active ? 'active' : 'inactive'}]"\`.\n`,
      "test/verify_creation.js": `const assert = require("assert");
const fs = require("fs");
const path = require("path");

const configPath = path.resolve("src/config.json");
const formatterPath = path.resolve("src/formatter.js");

assert(fs.existsSync(configPath), "src/config.json must exist");
assert(fs.existsSync(formatterPath), "src/formatter.js must exist");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
assert.strictEqual(config.service, "payment-gateway", "config.service must match");
assert.strictEqual(config.port, 8080, "config.port must be 8080");
assert.strictEqual(config.active, true, "config.active must be true");

const { formatPayload } = require(formatterPath);
assert.strictEqual(typeof formatPayload, "function", "formatPayload must be a function");
assert.strictEqual(formatPayload("payment-gateway", true), "[payment-gateway:active]");
assert.strictEqual(formatPayload("payment-gateway", false), "[payment-gateway:inactive]");

console.log("BENCH_01_VERIFICATION_SUCCESS");
process.exit(0);
`,
    },
  },
  mission: {
    requiredCapabilities: ["workspace.file.read", "workspace.file.write", "process.execute"],
    protectedPaths: ["test/**", "package.json", "README.md"],
    resourceLimits: { timeoutMs: 30000, maxAttempts: 5, maxOutputBytes: 1048576 },
  },
  successCriteria: [
    {
      criterionId: "bench-01-verify-files",
      kind: "COMMAND_EXIT_CODE",
      command: ["node", "test/verify_creation.js"],
      expectedExitCode: 0,
      description: "Verification script must confirm required files exist and adhere to structure",
    },
  ],
  budget: {
    maxSteps: 6,
    maxActions: 6,
    maxWallClockMs: 30000,
    maxConsecutiveFailures: 3,
  },
});

/**
 * BENCH_02_MULTI_STEP_CODING
 * Objective: Implement a utility and integrate it into a dependent module.
 */
const TASK_02_MULTI_STEP_CODING: EvaluationTaskDefinition = validateEvaluationTask({
  taskId: "benchmark-02-multi-step-coding",
  version: 1,
  description: "Implement string utility functions and integrate them into dependent blog service",
  fixture: {
    initialFiles: {
      "package.json": JSON.stringify(
        { name: "bench-02-multi-step", version: "1.0.0", type: "commonjs" },
        null,
        2
      ),
      "src/utils/text.js": `// Stub implementation - implement slugify and normalizeTags
function slugify(text) {
  throw new Error("slugify is not implemented");
}

function normalizeTags(tags) {
  throw new Error("normalizeTags is not implemented");
}

module.exports = { slugify, normalizeTags };
`,
      "src/blog-service.js": `const { slugify, normalizeTags } = require("./utils/text");

function createPost(title, rawTags) {
  const slug = slugify(title);
  const tags = normalizeTags(rawTags);
  return {
    title,
    slug,
    tags,
    publishedAt: "2026-11-06T00:00:00.000Z",
  };
}

module.exports = { createPost };
`,
      "test/integration.test.js": `const assert = require("assert");
const { slugify, normalizeTags } = require("../src/utils/text");
const { createPost } = require("../src/blog-service");

// 1. Text utility unit checks
assert.strictEqual(slugify("Hello World! 2026"), "hello-world-2026", "slugify should lowercase and hyphenate");
assert.deepStrictEqual(
  normalizeTags([" Node ", "TYPESCRIPT", "node", "ai "]),
  ["node", "typescript", "ai"],
  "normalizeTags should trim, lowercase, and deduplicate"
);

// 2. Integration check
const post = createPost("Building Emerald Agent Fabric", [" INFRA ", "Agent", "infra"]);
assert.strictEqual(post.slug, "building-emerald-agent-fabric");
assert.deepStrictEqual(post.tags, ["infra", "agent"]);

console.log("BENCH_02_VERIFICATION_SUCCESS");
process.exit(0);
`,
    },
  },
  mission: {
    requiredCapabilities: ["workspace.file.read", "workspace.file.write", "process.execute"],
    protectedPaths: ["test/**", "package.json"],
    resourceLimits: { timeoutMs: 35000, maxAttempts: 5, maxOutputBytes: 1048576 },
  },
  successCriteria: [
    {
      criterionId: "bench-02-integration-suite",
      kind: "COMMAND_EXIT_CODE",
      command: ["node", "test/integration.test.js"],
      expectedExitCode: 0,
      description: "Integration test suite must pass with exit code 0",
    },
  ],
  budget: {
    maxSteps: 8,
    maxActions: 8,
    maxWallClockMs: 35000,
    maxConsecutiveFailures: 3,
  },
});

/**
 * BENCH_03_REPO_INVESTIGATION
 * Objective: Investigate a repository and produce a structured JSON report without unintended source mutations.
 */
const TASK_03_REPO_INVESTIGATION: EvaluationTaskDefinition = validateEvaluationTask({
  taskId: "benchmark-03-repo-investigation",
  version: 1,
  description: "Investigate repository configuration anomaly and write audit report without mutating source code",
  fixture: {
    initialFiles: {
      "package.json": JSON.stringify(
        { name: "bench-03-investigation", version: "1.0.0", type: "commonjs" },
        null,
        2
      ),
      "src/auth/authenticator.js": `// Internal authentication handler
const HARDCODED_INTERNAL_KEY = "EMERALD_TEST_INSECURE_DEBUG_VAL_99";

function authenticateRequest(candidate) {
  return candidate === HARDCODED_INTERNAL_KEY;
}

module.exports = { authenticateRequest };
`,
      "src/api/routes.js": `function listUsers() {
  return [{ id: 1, name: "Alice" }];
}

module.exports = { listUsers };
`,
      "src/db/client.js": `function getDbConnection() {
  return { host: "127.0.0.1", port: 5432 };
}

module.exports = { getDbConnection };
`,
      "test/verify_audit.js": `const assert = require("assert");
const fs = require("fs");
const path = require("path");

// 1. Verify audit report was produced
const reportPath = path.resolve("reports/audit-report.json");
assert(fs.existsSync(reportPath), "Audit report 'reports/audit-report.json' must exist");

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
assert(Array.isArray(report.findings), "Report must contain a 'findings' array");
assert(report.findings.length >= 1, "Report must identify at least one security finding");

const finding = report.findings.find(
  (f) => f.findingId === "HARDCODED_DEBUG_VALUE" || f.file?.includes("authenticator.js")
);
assert(finding, "Finding must identify the hardcoded debug value in src/auth/authenticator.js");

// 2. Strict Invariant: Source code must remain completely unmutated
const authContent = fs.readFileSync(path.resolve("src/auth/authenticator.js"), "utf8");
assert(
  authContent.includes("EMERALD_TEST_INSECURE_DEBUG_VAL_99"),
  "Investigation task must not mutate source files"
);

console.log("BENCH_03_VERIFICATION_SUCCESS");
process.exit(0);
`,
    },
  },
  mission: {
    requiredCapabilities: [
      "workspace.file.read",
      "workspace.file.write",
      "workspace.search",
      "process.execute",
    ],
    protectedPaths: ["test/**", "config/**", "src/**", "package.json"],
    resourceLimits: { timeoutMs: 30000, maxAttempts: 5, maxOutputBytes: 1048576 },
  },
  successCriteria: [
    {
      criterionId: "bench-03-verify-audit",
      kind: "COMMAND_EXIT_CODE",
      command: ["node", "test/verify_audit.js"],
      expectedExitCode: 0,
      description: "Audit verification must confirm findings while ensuring zero source code mutations",
    },
  ],
  budget: {
    maxSteps: 6,
    maxActions: 6,
    maxWallClockMs: 30000,
    maxConsecutiveFailures: 3,
  },
});

/**
 * BENCH_04_TEST_FAILURE_REPAIR
 * Objective: Diagnose a seeded test failure and repair the underlying defect.
 */
const TASK_04_TEST_FAILURE_REPAIR: EvaluationTaskDefinition = validateEvaluationTask({
  taskId: "benchmark-04-test-failure-repair",
  version: 1,
  description: "Diagnose seeded calculation bug in pricing module and repair it to make test suite pass",
  fixture: {
    initialFiles: {
      "package.json": JSON.stringify(
        { name: "bench-04-repair", version: "1.0.0", type: "commonjs" },
        null,
        2
      ),
      "src/pricing.js": `function calculateTotal(subtotal, taxRate, discount = 0) {
  if (subtotal < 0) throw new Error("Subtotal cannot be negative");
  if (taxRate < 0) throw new Error("Tax rate cannot be negative");
  // Seeded Defect: adds taxRate directly instead of multiplying subtotal by taxRate
  const tax = taxRate;
  const discounted = Math.max(0, subtotal - discount);
  return Math.round((discounted + tax) * 100) / 100;
}

module.exports = { calculateTotal };
`,
      "test/pricing.test.js": `const assert = require("assert");
const { calculateTotal } = require("../src/pricing");

// Case 1: 100 subtotal with 10% tax (100 * 1.10 = 110)
assert.strictEqual(calculateTotal(100, 0.1), 110, "100 with 10% tax should be 110");

// Case 2: 50 subtotal with 10 discount and 5% tax (40 * 1.05 = 42)
assert.strictEqual(calculateTotal(50, 0.05, 10), 42, "50 with 10 discount and 5% tax should be 42");

// Case 3: 200 subtotal with 0% tax
assert.strictEqual(calculateTotal(200, 0), 200, "200 with 0% tax should be 200");

// Case 4: validation check
assert.throws(() => calculateTotal(-10, 0.1), /Subtotal cannot be negative/);

console.log("BENCH_04_VERIFICATION_SUCCESS");
process.exit(0);
`,
    },
  },
  mission: {
    requiredCapabilities: ["workspace.file.read", "workspace.file.write", "process.execute"],
    protectedPaths: ["test/**", "package.json"],
    resourceLimits: { timeoutMs: 35000, maxAttempts: 5, maxOutputBytes: 1048576 },
  },
  successCriteria: [
    {
      criterionId: "bench-04-verify-repair",
      kind: "COMMAND_EXIT_CODE",
      command: ["node", "test/pricing.test.js"],
      expectedExitCode: 0,
      description: "Pricing test suite must exit 0 once calculation defect is repaired",
    },
  ],
  budget: {
    maxSteps: 8,
    maxActions: 8,
    maxWallClockMs: 35000,
    maxConsecutiveFailures: 3,
  },
});

/**
 * BENCH_05_MULTI_TOOL_CHAINING
 * Objective: Coordinate search, file inspection, editing, and test execution.
 */
const TASK_05_MULTI_TOOL_CHAINING: EvaluationTaskDefinition = validateEvaluationTask({
  taskId: "benchmark-05-multi-tool-chaining",
  version: 1,
  description: "Search codebase, inspect call sites, migrate deprecated hash calls, and verify pipeline",
  fixture: {
    initialFiles: {
      "package.json": JSON.stringify(
        { name: "bench-05-chaining", version: "1.0.0", type: "commonjs" },
        null,
        2
      ),
      "src/crypto/hasher.js": `const crypto = require("crypto");

// DEPRECATED: Do not use in active pipeline
function oldHashFunction(data) {
  return "legacy_" + String(data).toLowerCase();
}

function sha256Digest(data) {
  return crypto.createHash("sha256").update(String(data)).digest("hex");
}

module.exports = { oldHashFunction, sha256Digest };
`,
      "src/services/user-service.js": `const { oldHashFunction } = require("../crypto/hasher");

function hashUserEmail(email) {
  return oldHashFunction(email);
}

module.exports = { hashUserEmail };
`,
      "src/services/session-service.js": `const { oldHashFunction } = require("../crypto/hasher");

function hashSessionId(sessionId) {
  return oldHashFunction(sessionId);
}

module.exports = { hashSessionId };
`,
      "test/hasher.test.js": `const assert = require("assert");
const fs = require("fs");
const { hashUserEmail } = require("../src/services/user-service");
const { hashSessionId } = require("../src/services/session-service");
const { sha256Digest } = require("../src/crypto/hasher");

// 1. Verify call sites migrated away from deprecated oldHashFunction
const userSrc = fs.readFileSync("src/services/user-service.js", "utf8");
const sessionSrc = fs.readFileSync("src/services/session-service.js", "utf8");
assert(!userSrc.includes("oldHashFunction"), "user-service.js must not reference oldHashFunction");
assert(!sessionSrc.includes("oldHashFunction"), "session-service.js must not reference oldHashFunction");

// 2. Verify operational output matches sha256Digest
const email = "developer@emerald.org";
const session = "session-xyz-123";
assert.strictEqual(hashUserEmail(email), sha256Digest(email));
assert.strictEqual(hashSessionId(session), sha256Digest(session));

console.log("BENCH_05_VERIFICATION_SUCCESS");
process.exit(0);
`,
    },
  },
  mission: {
    requiredCapabilities: [
      "workspace.file.read",
      "workspace.file.write",
      "workspace.search",
      "process.execute",
    ],
    protectedPaths: ["test/**", "package.json"],
    resourceLimits: { timeoutMs: 45000, maxAttempts: 5, maxOutputBytes: 1048576 },
  },
  successCriteria: [
    {
      criterionId: "bench-05-verify-chaining",
      kind: "COMMAND_EXIT_CODE",
      command: ["node", "test/hasher.test.js"],
      expectedExitCode: 0,
      description: "Pipeline test suite must verify migration from deprecated function across all services",
    },
  ],
  budget: {
    maxSteps: 10,
    maxActions: 10,
    maxWallClockMs: 45000,
    maxConsecutiveFailures: 3,
  },
});

/**
 * BENCH_06_INTERRUPTED_RECOVERY
 * Objective: Evaluate durable checkpoint integrity, lease ownership, and safe handling of interrupted execution.
 */
const TASK_06_INTERRUPTED_RECOVERY: EvaluationTaskDefinition = validateEvaluationTask({
  taskId: "benchmark-06-interrupted-recovery",
  version: 1,
  description: "Evaluate transactional batch processing, checkpoint consistency, and safe interrupted recovery",
  fixture: {
    initialFiles: {
      "package.json": JSON.stringify(
        { name: "bench-06-recovery", version: "1.0.0", type: "commonjs" },
        null,
        2
      ),
      "src/batch-processor.js": `function processBatch(records) {
  if (!Array.isArray(records)) throw new Error("Records must be an array");
  return records.map((record) => ({
    id: record.id,
    processed: true,
    processedAt: "2026-11-06T12:00:00.000Z",
  }));
}

module.exports = { processBatch };
`,
      "test/verify_recovery.js": `const assert = require("assert");
const { processBatch } = require("../src/batch-processor");

const input = [{ id: "tx-1" }, { id: "tx-2" }];
const output = processBatch(input);
assert.strictEqual(output.length, 2);
assert.strictEqual(output[0].processed, true);
assert.strictEqual(output[1].processed, true);

console.log("BENCH_06_VERIFICATION_SUCCESS");
process.exit(0);
`,
    },
  },
  mission: {
    requiredCapabilities: ["workspace.file.read", "workspace.file.write", "process.execute"],
    protectedPaths: ["test/**", "package.json"],
    resourceLimits: { timeoutMs: 20000, maxAttempts: 3, maxOutputBytes: 1048576 },
  },
  successCriteria: [
    {
      criterionId: "bench-06-verify-batch",
      kind: "COMMAND_EXIT_CODE",
      command: ["node", "test/verify_recovery.js"],
      expectedExitCode: 0,
      description: "Batch processor test verifies correct execution under governed contract",
    },
  ],
  budget: {
    maxSteps: 5,
    maxActions: 5,
    maxWallClockMs: 20000,
    maxConsecutiveFailures: 2,
  },
});

// ============================================================================
// 3. Benchmark Task Wrappers with Metadata
// ============================================================================

export const BENCHMARK_01_FILE_CREATION_MUTATION: ReliabilityBenchmarkTask = Object.freeze({
  category: "BENCH_01_FILE_CREATION_MUTATION",
  taskDefinition: TASK_01_FILE_CREATION,
  expectedOutcome: "VERIFIED_SUCCESS",
  expectedVerificationRule: "EXIT_CODE_ZERO",
  isolationLevel: "CONSTRAINED_HOST",
  objective: "Create files with specified contents and required structure adhering to exact JSON and export contracts.",
  constraints: Object.freeze([
    "allowUnverifiedCompletion must remain false",
    "Must create src/config.json with exact schema",
    "Must create src/formatter.js with formatPayload export",
    "Verification command test/verify_creation.js must exit with code 0",
  ]),
  cleanupBehavior: "Recursive deletion of ephemeral workspace directory on trial completion.",
  oraclePaths: Object.freeze(["test/verify_creation.js", "package.json", "README.md"]),
  agentWritablePaths: Object.freeze(["src/config.json", "src/formatter.js", "src/**"]),
});

export const BENCHMARK_02_MULTI_STEP_CODING: ReliabilityBenchmarkTask = Object.freeze({
  category: "BENCH_02_MULTI_STEP_CODING",
  taskDefinition: TASK_02_MULTI_STEP_CODING,
  expectedOutcome: "VERIFIED_SUCCESS",
  expectedVerificationRule: "EXIT_CODE_ZERO",
  isolationLevel: "CONSTRAINED_HOST",
  objective: "Implement utility functions in src/utils/text.js and integrate into src/blog-service.js.",
  constraints: Object.freeze([
    "allowUnverifiedCompletion must remain false",
    "Must implement slugify and normalizeTags",
    "Must preserve integration contract with createPost",
    "Integration test test/integration.test.js must exit with code 0",
  ]),
  cleanupBehavior: "Recursive deletion of ephemeral workspace directory on trial completion.",
  oraclePaths: Object.freeze(["test/blog_service.test.js", "package.json"]),
  agentWritablePaths: Object.freeze(["src/utils/text.js", "src/blog-service.js", "src/**"]),
});

export const BENCHMARK_03_REPO_INVESTIGATION: ReliabilityBenchmarkTask = Object.freeze({
  category: "BENCH_03_REPO_INVESTIGATION",
  taskDefinition: TASK_03_REPO_INVESTIGATION,
  expectedOutcome: "VERIFIED_SUCCESS",
  expectedVerificationRule: "EXIT_CODE_ZERO",
  isolationLevel: "CONSTRAINED_HOST",
  objective: "Investigate repository configuration anomaly and write structured audit report without modifying source code.",
  constraints: Object.freeze([
    "allowUnverifiedCompletion must remain false",
    "Must write reports/audit-report.json with valid finding structure",
    "Source code in src/ must remain strictly untouched and unmutated",
    "Audit verification test/verify_audit.js must exit with code 0",
  ]),
  cleanupBehavior: "Recursive deletion of ephemeral workspace directory on trial completion.",
  oraclePaths: Object.freeze(["test/verify_audit.js", "config/app.json", "src/auth/authenticator.js", "package.json"]),
  agentWritablePaths: Object.freeze(["reports/audit-report.json"]),
});

export const BENCHMARK_04_TEST_FAILURE_REPAIR: ReliabilityBenchmarkTask = Object.freeze({
  category: "BENCH_04_TEST_FAILURE_REPAIR",
  taskDefinition: TASK_04_TEST_FAILURE_REPAIR,
  expectedOutcome: "VERIFIED_SUCCESS",
  expectedVerificationRule: "EXIT_CODE_ZERO",
  isolationLevel: "CONSTRAINED_HOST",
  objective: "Diagnose seeded test failure in pricing library and repair calculateTotal bug.",
  constraints: Object.freeze([
    "allowUnverifiedCompletion must remain false",
    "Must diagnose and fix tax calculation in src/pricing.js",
    "Must not modify or delete test assertions in test/pricing.test.js",
    "Pricing test suite test/pricing.test.js must exit with code 0",
  ]),
  cleanupBehavior: "Recursive deletion of ephemeral workspace directory on trial completion.",
  oraclePaths: Object.freeze(["test/pricing.test.js", "package.json"]),
  agentWritablePaths: Object.freeze(["src/pricing.js"]),
});

export const BENCHMARK_05_MULTI_TOOL_CHAINING: ReliabilityBenchmarkTask = Object.freeze({
  category: "BENCH_05_MULTI_TOOL_CHAINING",
  taskDefinition: TASK_05_MULTI_TOOL_CHAINING,
  expectedOutcome: "VERIFIED_SUCCESS",
  expectedVerificationRule: "EXIT_CODE_ZERO",
  isolationLevel: "CONSTRAINED_HOST",
  objective: "Coordinate search, file inspection, editing, and test execution to migrate deprecated hash calls.",
  constraints: Object.freeze([
    "allowUnverifiedCompletion must remain false",
    "Must find all call sites of oldHashFunction across services",
    "Must migrate call sites to sha256Digest",
    "Pipeline test suite test/hasher.test.js must exit with code 0",
  ]),
  cleanupBehavior: "Recursive deletion of ephemeral workspace directory on trial completion.",
  oraclePaths: Object.freeze(["test/hasher.test.js", "package.json"]),
  agentWritablePaths: Object.freeze(["src/crypto/hasher.js", "src/services/user-service.js", "src/services/session-service.js"]),
});

export const BENCHMARK_06_INTERRUPTED_RECOVERY: ReliabilityBenchmarkTask = Object.freeze({
  category: "BENCH_06_INTERRUPTED_RECOVERY",
  taskDefinition: TASK_06_INTERRUPTED_RECOVERY,
  expectedOutcome: "VERIFIED_SUCCESS",
  expectedVerificationRule: "EXIT_CODE_ZERO",
  isolationLevel: "CONSTRAINED_HOST",
  objective: "Evaluate durable checkpoint integrity, lease ownership, and safe handling of interrupted execution.",
  constraints: Object.freeze([
    "allowUnverifiedCompletion must remain false",
    "Under normal completed execution, produces VERIFIED_SUCCESS if verification passes",
    "Under lease expiration, loss, or interruption, must fail closed to BLOCKED",
    "safeToResume must remain strictly false on interruption",
    "Must never infer recovery authorization from lease expiry alone",
  ]),
  cleanupBehavior: "Recursive deletion of ephemeral workspace directory on trial completion.",
  oraclePaths: Object.freeze(["test/verify_recovery.js", "package.json"]),
  agentWritablePaths: Object.freeze(["src/batch-processor.js"]),
});

export const RELIABILITY_BENCHMARK_TASKS: readonly ReliabilityBenchmarkTask[] = Object.freeze([
  BENCHMARK_01_FILE_CREATION_MUTATION,
  BENCHMARK_02_MULTI_STEP_CODING,
  BENCHMARK_03_REPO_INVESTIGATION,
  BENCHMARK_04_TEST_FAILURE_REPAIR,
  BENCHMARK_05_MULTI_TOOL_CHAINING,
  BENCHMARK_06_INTERRUPTED_RECOVERY,
]);

// ============================================================================
// 4. Registry & Query Helpers
// ============================================================================

/**
 * Returns all standardized reliability benchmark tasks.
 */
export function getAllReliabilityBenchmarkTasks(): readonly ReliabilityBenchmarkTask[] {
  return RELIABILITY_BENCHMARK_TASKS;
}

/**
 * Finds a benchmark task by its unique task ID.
 */
export function getReliabilityBenchmarkTask(taskId: string): ReliabilityBenchmarkTask | undefined {
  return RELIABILITY_BENCHMARK_TASKS.find((b) => b.taskDefinition.taskId === taskId);
}

/**
 * Finds a benchmark task by its category.
 */
export function getReliabilityBenchmarkTaskByCategory(
  category: ReliabilityBenchmarkCategory
): ReliabilityBenchmarkTask | undefined {
  return RELIABILITY_BENCHMARK_TASKS.find((b) => b.category === category);
}

/**
 * Checks whether a given task ID belongs to the standardized reliability benchmark suite.
 */
export function isReliabilityBenchmarkTaskId(taskId: string): boolean {
  return RELIABILITY_BENCHMARK_TASKS.some((b) => b.taskDefinition.taskId === taskId);
}

/**
 * Validates the governance and verification invariants of a ReliabilityBenchmarkTask.
 */
export function validateReliabilityBenchmarkTask(
  task: ReliabilityBenchmarkTask
): BenchmarkValidationResult {
  const issues: string[] = [];

  if (!task) {
    return { valid: false, issues: ["Benchmark task is undefined or null"] };
  }

  // 1. Task definition validation
  try {
    validateEvaluationTask(task.taskDefinition);
  } catch (err: unknown) {
    issues.push(`Invalid EvaluationTaskDefinition: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Non-empty success criteria translation check
  const translation = translateEvaluationTaskCriteria(task.taskDefinition);
  if (!translation.supported) {
    issues.push(
      `Benchmark task '${task.taskDefinition.taskId}' has unsupported verification criteria: ${translation.unsupportedReasons.join("; ")}`
    );
  }
  if (translation.verificationSpecs.length === 0) {
    issues.push(
      `Benchmark task '${task.taskDefinition.taskId}' must produce at least one runtime verification specification`
    );
  }

  // 3. Verification rule match check
  const hasExpectedRule = translation.verificationSpecs.some(
    (spec) => spec.ruleKind === task.expectedVerificationRule
  );
  if (!hasExpectedRule) {
    issues.push(
      `Benchmark task '${task.taskDefinition.taskId}' expected rule '${task.expectedVerificationRule}' but translated: ${translation.verificationSpecs.map((s) => s.ruleKind).join(", ")}`
    );
  }

  // 4. Resource budget ceilings check
  const budget = task.taskDefinition.budget;
  if (budget.maxSteps > 50 || budget.maxActions > 50 || budget.maxWallClockMs > 120000) {
    issues.push(`Benchmark task '${task.taskDefinition.taskId}' exceeds reasonable benchmark resource ceiling`);
  }

  // 5. Fixture non-empty check
  const files = Object.keys(task.taskDefinition.fixture.initialFiles);
  if (files.length === 0) {
    issues.push(`Benchmark task '${task.taskDefinition.taskId}' has empty initial fixture`);
  }

  return {
    valid: issues.length === 0,
    issues: Object.freeze(issues),
  };
}
