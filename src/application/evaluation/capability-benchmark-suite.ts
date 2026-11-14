/**
 * Comprehensive Benchmark Suite for Capability Gates G2–G7 and G9.
 *
 * Implements deterministic, reproducible benchmark tasks for each gate:
 * - G2_REPO_NAVIGATION: Locates relevant target files in unfamiliar directory hierarchies
 * - G3_CODE_UNDERSTANDING: Identifies root cause defect locations and explains failures
 * - G4_SINGLE_FILE_REPAIR: Produces verified single-file repairs satisfying test oracles
 * - G5_MULTI_FILE_REPAIR: Produces coordinated multi-file repairs satisfying integration tests
 * - G6_REGRESSION_AWARENESS: Repairs failing tests while guaranteeing 0 pass-to-pass regressions
 * - G7_BEHAVIORAL_CONSISTENCY: Asserts deterministic proposal hash identity across repeated trials at temp 0
 * - G9_FAILURE_RECOVERY: Shifts tool approach after tool failure or rejection rather than repeating
 */

import { DualGateEvaluationTask } from "../../domain/dual-gate-evaluation.js";
import { ModelCapabilityGateId } from "../../domain/model-routing.js";

export const CAPABILITY_BENCHMARK_TASKS: readonly DualGateEvaluationTask[] = [
  // ==========================================================================
  // G2: REPOSITORY NAVIGATION
  // ==========================================================================
  {
    taskId: "g2-nav-01-locate-auth-service",
    gateId: "G2_REPO_NAVIGATION",
    title: "Locate Authentication Token Signer",
    description: "Navigate an unfamiliar repository tree to find the JWT token signer service.",
    version: "1.0.0",
    initialFiles: {
      "README.md": "# Service Monorepo\nSee packages for individual services.",
      "packages/gateway/src/index.js": "console.log('Gateway active');",
      "packages/services/auth/src/jwt-signer.js": "export function signToken(payload, key) { return 'signed.' + payload; }",
      "packages/services/auth/src/verifier.js": "export function verifyToken(token) { return true; }",
      "packages/services/users/src/user-store.js": "export class UserStore {}",
      "packages/utils/common/src/string.js": "export const trim = (s) => s.trim();",
    },
    inputPrompt: "Locate the authentication token signing implementation in the repository and inspect its signature.",
    allowedTools: ["read_file", "search_code"],
    resourceLimits: { timeoutMs: 30000, maxSteps: 3, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTargetFiles: ["packages/services/auth/src/jwt-signer.js"],
      expectedCitations: ["signToken", "jwt-signer.js"],
    },
    gateBCriteria: {
      verifierType: "CLEANROOM_ORACLE",
    },
  },
  {
    taskId: "g2-nav-02-locate-db-pool",
    gateId: "G2_REPO_NAVIGATION",
    title: "Locate Database Connection Pool",
    description: "Find the database connection pool manager in the infrastructure tree.",
    version: "1.0.0",
    initialFiles: {
      "src/app.js": "import { initDb } from './infra/db/pool.js';",
      "src/infra/db/pool.js": "export function createPool(config) { return { connections: 10 }; }",
      "src/infra/cache/redis.js": "export function getClient() { return {}; }",
      "src/routes/api.js": "export const routes = [];",
    },
    inputPrompt: "Find where database connection pool creation is implemented.",
    allowedTools: ["read_file", "search_code"],
    resourceLimits: { timeoutMs: 30000, maxSteps: 3, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTargetFiles: ["src/infra/db/pool.js"],
      expectedCitations: ["createPool", "pool.js"],
    },
    gateBCriteria: {
      verifierType: "CLEANROOM_ORACLE",
    },
  },
  {
    taskId: "g2-nav-03-locate-logger",
    gateId: "G2_REPO_NAVIGATION",
    title: "Locate HTTP Request Logger",
    description: "Locate the HTTP request logging middleware in the middleware directory.",
    version: "1.0.0",
    initialFiles: {
      "src/server.js": "import { logger } from './middleware/logger.js';",
      "src/middleware/auth.js": "export function auth() {}",
      "src/middleware/logger.js": "export function requestLogger(req, res, next) { console.log(req.url); next(); }",
      "src/middleware/rate-limit.js": "export function rateLimit() {}",
    },
    inputPrompt: "Find the middleware responsible for logging incoming HTTP requests.",
    allowedTools: ["read_file", "search_code"],
    resourceLimits: { timeoutMs: 30000, maxSteps: 3, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTargetFiles: ["src/middleware/logger.js"],
      expectedCitations: ["requestLogger", "logger.js"],
    },
    gateBCriteria: {
      verifierType: "CLEANROOM_ORACLE",
    },
  },
  {
    taskId: "g2-nav-04-locate-error-handler",
    gateId: "G2_REPO_NAVIGATION",
    title: "Locate API Error Handler",
    description: "Find the centralized error handler handler in the handlers hierarchy.",
    version: "1.0.0",
    initialFiles: {
      "src/handlers/users.js": "export function getUsers() {}",
      "src/handlers/posts.js": "export function getPosts() {}",
      "src/handlers/errors/global-error.js": "export function errorHandler(err) { return { status: 500, error: err.message }; }",
      "src/config/app.json": "{\"env\": \"production\"}",
    },
    inputPrompt: "Find the centralized global error handler implementation.",
    allowedTools: ["read_file", "search_code"],
    resourceLimits: { timeoutMs: 30000, maxSteps: 3, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTargetFiles: ["src/handlers/errors/global-error.js"],
      expectedCitations: ["errorHandler", "global-error.js"],
    },
    gateBCriteria: {
      verifierType: "CLEANROOM_ORACLE",
    },
  },
  {
    taskId: "g2-nav-05-decoy-boundary",
    gateId: "G2_REPO_NAVIGATION",
    title: "Distinguish Production Configuration from Decoy",
    description: "Accurately locate the active production config file rather than sample/decoy documentation.",
    version: "1.0.0",
    isNegativeCase: true,
    initialFiles: {
      "docs/sample-config.json": "{\"database\": \"sample-mock-db\"}",
      "examples/mock-config.json": "{\"database\": \"example-db\"}",
      "config/production.json": "{\"database\": \"prod-aurora-cluster\", \"ssl\": true}",
    },
    inputPrompt: "Locate the active production configuration file, avoiding sample or mock configs.",
    allowedTools: ["read_file", "search_code"],
    resourceLimits: { timeoutMs: 30000, maxSteps: 3, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTargetFiles: ["config/production.json"],
      expectedCitations: ["prod-aurora-cluster", "production.json"],
    },
    gateBCriteria: {
      verifierType: "CLEANROOM_ORACLE",
    },
  },

  // ==========================================================================
  // G3: CODE UNDERSTANDING & DIAGNOSIS
  // ==========================================================================
  {
    taskId: "g3-diag-01-off-by-one",
    gateId: "G3_CODE_UNDERSTANDING",
    title: "Diagnose Off-by-One Array Slice Defect",
    description: "Identify the root cause of an off-by-one slice error from failing test output.",
    version: "1.1.0",
    initialFiles: {
      "src/chunker.js": "export function chunkArray(arr, size) {\n  const result = [];\n  for (let i = 0; i <= arr.length; i += size) {\n    result.push(arr.slice(i, i + size));\n  }\n  return result;\n}",
      "test-output.txt": "AssertionError: Expected array length 3, got 4 (final chunk is empty array [])\nTest case: chunkArray([1, 2, 3, 4, 5, 6], 2)",
    },
    inputPrompt: "Diagnose the defect in chunkArray causing an empty final chunk based on test-output.txt. State the target file, line number, and why it causes an empty chunk.",
    allowedTools: ["read_file", "search_code"],
    resourceLimits: { timeoutMs: 80000, stepTimeoutMs: 35000, maxSteps: 2, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTargetFiles: ["src/chunker.js"],
      expectedCitations: ["i <= arr.length", "i < arr.length", "line 3"],
    },
    gateBCriteria: {
      verifierType: "CLEANROOM_ORACLE",
      diagnosticGrounding: {
        targetFile: "src/chunker.js",
        defectiveLineNumbers: [3],
        causalKeywords: ["i <= arr.length", "i < arr.length", "slice", "empty chunk", "loop", "length"],
        validateDiagnosis: (diag: string, _src: string) => {
          const lower = diag.toLowerCase();
          const hasBoundary = lower.includes("i <=") || lower.includes("<=") || lower.includes("off-by-one") || lower.includes("termination") || lower.includes("boundary");
          const hasSliceOrChunk = lower.includes("empty") || lower.includes("chunk") || lower.includes("slice") || lower.includes("length");
          const hasContradiction = lower.includes("slice is broken") || lower.includes("delete slice") || lower.includes("loop is correct") || lower.includes("not off-by-one");
          const isEchoOnly = lower.includes("test case:") && !hasBoundary;

          if (!hasBoundary) return { valid: false, reason: "Diagnosis fails to identify loop termination condition (<= vs <) as the cause" };
          if (!hasSliceOrChunk) return { valid: false, reason: "Diagnosis fails to explain why the boundary produces an empty slice" };
          if (hasContradiction) return { valid: false, reason: "Diagnosis contains contradictory or incorrect defect attribution" };
          if (isEchoOnly) return { valid: false, reason: "Diagnosis repeats test trace without explaining causal mechanism" };
          return { valid: true };
        },
      },
    },
  },
  {
    taskId: "g3-diag-02-null-dereference",
    gateId: "G3_CODE_UNDERSTANDING",
    title: "Diagnose Unchecked Property Access",
    description: "Identify the missing null check causing a runtime TypeError.",
    version: "1.1.0",
    initialFiles: {
      "src/user-service.js": "export function getUserDisplayName(user) {\n  return user.profile.displayName.toUpperCase();\n}",
      "test-output.txt": "TypeError: Cannot read property 'displayName' of undefined at getUserDisplayName (unknown source)\nTest case: getUserDisplayName({ id: 'usr_101' })",
    },
    inputPrompt: "Diagnose the failure in src/user-service.js. Identify the missing check and state the line number.",
    allowedTools: ["read_file"],
    resourceLimits: { timeoutMs: 80000, stepTimeoutMs: 35000, maxSteps: 2, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTargetFiles: ["src/user-service.js"],
      expectedCitations: ["user.profile", "line 2", "undefined"],
    },
    gateBCriteria: {
      verifierType: "CLEANROOM_ORACLE",
      diagnosticGrounding: {
        targetFile: "src/user-service.js",
        defectiveLineNumbers: [2],
        causalKeywords: ["user.profile", "displayName", "undefined", "null"],
        validateDiagnosis: (diag: string, _src: string) => {
          const lower = diag.toLowerCase();
          const hasProfile = lower.includes("user.profile") || (lower.includes("profile") && lower.includes("user"));
          const hasDeref = lower.includes("undefined") || lower.includes("null") || lower.includes("missing check") || lower.includes("optional chaining") || lower.includes("guard");
          const hasContradiction = lower.includes("touppercase is broken") || lower.includes("user is undefined") || lower.includes("delete touppercase");

          if (!hasProfile) return { valid: false, reason: "Diagnosis fails to identify user.profile as the missing or undefined property" };
          if (!hasDeref) return { valid: false, reason: "Diagnosis fails to explain the undefined property dereference causing TypeError" };
          if (hasContradiction) return { valid: false, reason: "Diagnosis incorrectly attributes defect to toUpperCase or assumes user object is missing" };
          return { valid: true };
        },
      },
    },
  },
  {
    taskId: "g3-diag-03-division-by-zero",
    gateId: "G3_CODE_UNDERSTANDING",
    title: "Diagnose Unhandled Zero Denominator",
    description: "Identify unhandled zero denominator producing NaN/Infinity in financial calculator.",
    version: "1.1.0",
    initialFiles: {
      "src/rate.js": "export function computeEffectiveRate(interest, principal) {\n  return interest / principal;\n}",
      "test-output.txt": "AssertionError: Expected rate for 0 principal to be 0 or throw error, received Infinity at computeEffectiveRate\nTest case: computeEffectiveRate(500, 0)",
    },
    inputPrompt: "Diagnose why computeEffectiveRate returns Infinity in src/rate.js. State the line number and explain the cause.",
    allowedTools: ["read_file"],
    resourceLimits: { timeoutMs: 80000, stepTimeoutMs: 35000, maxSteps: 2, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTargetFiles: ["src/rate.js"],
      expectedCitations: ["principal === 0", "division by zero", "line 2"],
    },
    gateBCriteria: {
      verifierType: "CLEANROOM_ORACLE",
      diagnosticGrounding: {
        targetFile: "src/rate.js",
        defectiveLineNumbers: [2],
        causalKeywords: ["principal === 0", "division by zero", "zero", "Infinity"],
        validateDiagnosis: (diag: string, _src: string) => {
          const lower = diag.toLowerCase();
          const hasZero = lower.includes("principal === 0") || lower.includes("principal is 0") || lower.includes("zero principal") || lower.includes("division by zero") || lower.includes("zero denominator") || (lower.includes("principal") && lower.includes("0"));
          const hasInfinity = lower.includes("infinity") || lower.includes("divide by zero") || lower.includes("division by zero");
          const hasContradiction = lower.includes("interest is zero") || lower.includes("returns nan");

          if (!hasZero) return { valid: false, reason: "Diagnosis fails to identify unhandled zero principal denominator" };
          if (!hasInfinity) return { valid: false, reason: "Diagnosis fails to explain division by zero producing Infinity" };
          if (hasContradiction) return { valid: false, reason: "Diagnosis incorrectly attributes defect to interest parameter" };
          return { valid: true };
        },
      },
    },
  },
  {
    taskId: "g3-diag-04-async-race",
    gateId: "G3_CODE_UNDERSTANDING",
    title: "Diagnose Unawaited Promise Race Condition",
    description: "Identify unawaited database write promise causing race condition.",
    version: "1.1.0",
    initialFiles: {
      "src/worker.js": "export async function persistJob(db, job) {\n  db.save(job);\n  return { success: true };\n}",
      "test-output.txt": "AssertionError: Expected record in database, but table is empty\nTest case: await persistJob(mockDb, { id: 'job_99' })",
    },
    inputPrompt: "Diagnose why persistJob does not commit the record before returning in src/worker.js. State the line number and missing keyword.",
    allowedTools: ["read_file"],
    resourceLimits: { timeoutMs: 80000, stepTimeoutMs: 35000, maxSteps: 2, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTargetFiles: ["src/worker.js"],
      expectedCitations: ["await", "db.save", "line 2"],
    },
    gateBCriteria: {
      verifierType: "CLEANROOM_ORACLE",
      diagnosticGrounding: {
        targetFile: "src/worker.js",
        defectiveLineNumbers: [2],
        causalKeywords: ["await", "db.save", "promise", "async"],
        validateDiagnosis: (diag: string, _src: string) => {
          const lower = diag.toLowerCase();
          const hasAwait = lower.includes("await") || lower.includes("unawaited") || lower.includes("async race") || lower.includes("promise");
          const hasDb = lower.includes("db.save") || lower.includes("save") || lower.includes("commit");
          const hasContradiction = lower.includes("do not await") || lower.includes("db.save throws") || lower.includes("remove async");

          if (!hasAwait) return { valid: false, reason: "Diagnosis fails to identify missing await or asynchronous promise handling" };
          if (!hasDb) return { valid: false, reason: "Diagnosis fails to identify db.save call as the unawaited asynchronous operation" };
          if (hasContradiction) return { valid: false, reason: "Diagnosis contains contradictory advice against awaiting asynchronous calls" };
          return { valid: true };
        },
      },
    },
  },
  {
    taskId: "g3-diag-05-healthy-boundary",
    gateId: "G3_CODE_UNDERSTANDING",
    title: "Diagnose Test Oracle Defect Without Mutating Healthy Code",
    description: "Recognize that the production implementation is correct and the test oracle is flawed.",
    version: "1.1.0",
    isNegativeCase: true,
    initialFiles: {
      "src/math.js": "export function add(a, b) {\n  return a + b;\n}",
      "test/math.test.js": "import { add } from '../src/math.js';\nconst result = add(2, 2);\nif (result !== 5) throw new Error('Test failed: 2+2 must equal 5');",
    },
    inputPrompt: "Inspect src/math.js and test/math.test.js. Determine whether the defect is in the source code or test oracle.",
    allowedTools: ["read_file"],
    resourceLimits: { timeoutMs: 80000, stepTimeoutMs: 35000, maxSteps: 2, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTargetFiles: ["test/math.test.js"],
      expectedCitations: ["test oracle", "math.test.js", "2+2"],
    },
    gateBCriteria: {
      verifierType: "CLEANROOM_ORACLE",
      diagnosticGrounding: {
        targetFile: "test/math.test.js",
        defectiveLineNumbers: [3],
        causalKeywords: ["test oracle", "math.test.js", "2+2", "5", "flawed"],
        healthyFiles: ["src/math.js"],
        validateDiagnosis: (diag: string, _src: string) => {
          const lower = diag.toLowerCase();
          const blamesTest = lower.includes("test oracle") || lower.includes("math.test.js") || lower.includes("test is defective") || lower.includes("test is flawed") || lower.includes("oracle") || lower.includes("test failed");
          const verifiesCode = lower.includes("src/math.js") || lower.includes("math.js is correct") || lower.includes("math.js implementation is correct") || lower.includes("correct") || lower.includes("healthy") || lower.includes("2+2=4") || lower.includes("2 + 2 = 4");
          const blamesCode = lower.includes("defect in src/math.js") || lower.includes("defect in math.js") || lower.includes("bug in math.js") || lower.includes("modify src/math.js") || lower.includes("fix math.js");

          if (!blamesTest) return { valid: false, reason: "Diagnosis fails to identify the test oracle in test/math.test.js as defective" };
          if (blamesCode) return { valid: false, reason: "Diagnosis falsely attributes defect to healthy production implementation in src/math.js" };
          if (!verifiesCode) return { valid: false, reason: "Diagnosis fails to affirm correctness of src/math.js" };
          return { valid: true };
        },
      },
    },
  },

  // ==========================================================================
  // G4: SINGLE FILE REPAIR
  // ==========================================================================
  {
    taskId: "g4-repair-01-fix-math-pow",
    gateId: "G4_SINGLE_FILE_REPAIR",
    title: "Repair Power Exponentiation Function",
    description: "Fix bug in math-pow.js where base * exp was returned instead of base ** exp.",
    version: "1.1.0",
    initialFiles: {
      "src/math-pow.js": "export function power(base, exp) {\n  return base * exp;\n}\n",
      "test/math-pow.test.js": "import { power } from '../src/math-pow.js';\nif (power(2, 3) !== 8) process.exit(1);\nif (power(5, 0) !== 1) process.exit(1);\nif (power(3, 2) !== 9) process.exit(1);\nconsole.log('TEST_PASSED');\n",
    },
    inputPrompt: "Fix the bug in src/math-pow.js so that power(base, exp) computes exponentiation correctly and test/math-pow.test.js passes.",
    allowedTools: ["read_file", "write_file"],
    resourceLimits: { timeoutMs: 150000, stepTimeoutMs: 35000, maxSteps: 4, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTool: "write_file",
      expectedTargetFiles: ["src/math-pow.js"],
    },
    gateBCriteria: {
      verifierType: "TEST_RUNNER",
      expectedFiles: {
        "src/math-pow.js": (c: string) => c.includes("**") || c.includes("Math.pow"),
      },
      immutableFiles: ["test/math-pow.test.js"],
      testRunner: {
        targetModule: "src/math-pow.js",
        testAssertions: `
          if (power(2, 3) !== 8) throw new Error("power(2, 3) must equal 8");
          if (power(5, 0) !== 1) throw new Error("power(5, 0) must equal 1");
          if (power(3, 2) !== 9) throw new Error("power(3, 2) must equal 9");
          if (power(2, 10) !== 1024) throw new Error("power(2, 10) must equal 1024");
          if (power(-2, 3) !== -8) throw new Error("power(-2, 3) must equal -8");
          if (power(-2, 4) !== 16) throw new Error("power(-2, 4) must equal 16");
        `,
      },
    },
  },
  {
    taskId: "g4-repair-02-fix-clamp",
    gateId: "G4_SINGLE_FILE_REPAIR",
    title: "Repair Number Clamping Logic",
    description: "Fix bug in clamp.js where min and max checks were inverted.",
    version: "1.1.0",
    initialFiles: {
      "src/clamp.js": "export function clamp(val, min, max) {\n  if (val > min) return min;\n  if (val < max) return max;\n  return val;\n}\n",
      "test/clamp.test.js": "import { clamp } from '../src/clamp.js';\nif (clamp(5, 0, 10) !== 5) process.exit(1);\nif (clamp(-5, 0, 10) !== 0) process.exit(1);\nif (clamp(15, 0, 10) !== 10) process.exit(1);\nconsole.log('TEST_PASSED');\n",
    },
    inputPrompt: "Fix src/clamp.js so that numbers are clamped between min and max correctly.",
    allowedTools: ["read_file", "write_file"],
    resourceLimits: { timeoutMs: 150000, stepTimeoutMs: 35000, maxSteps: 4, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTool: "write_file",
      expectedTargetFiles: ["src/clamp.js"],
    },
    gateBCriteria: {
      verifierType: "TEST_RUNNER",
      expectedFiles: {
        "src/clamp.js": (c: string) => (c.includes("val < min") && c.includes("val > max")) || (c.includes("Math.min") && c.includes("Math.max")),
      },
      immutableFiles: ["test/clamp.test.js"],
      testRunner: {
        targetModule: "src/clamp.js",
        testAssertions: `
          if (clamp(5, 0, 10) !== 5) throw new Error("clamp(5, 0, 10) must equal 5");
          if (clamp(-5, 0, 10) !== 0) throw new Error("clamp(-5, 0, 10) must equal 0");
          if (clamp(15, 0, 10) !== 10) throw new Error("clamp(15, 0, 10) must equal 10");
          if (clamp(0, 0, 10) !== 0) throw new Error("clamp min boundary must equal 0");
          if (clamp(10, 0, 10) !== 10) throw new Error("clamp max boundary must equal 10");
          if (clamp(-15, -10, -5) !== -10) throw new Error("negative range clamping failed");
          if (clamp(-2, -10, -5) !== -5) throw new Error("negative range max clamping failed");
        `,
      },
    },
  },
  {
    taskId: "g4-repair-03-fix-array-unique",
    gateId: "G4_SINGLE_FILE_REPAIR",
    title: "Repair Array Deduplication Function",
    description: "Fix bug in array-dedup.js returning unmodified array.",
    version: "1.1.0",
    initialFiles: {
      "src/array-dedup.js": "export function unique(arr) {\n  return arr;\n}\n",
      "test/array-dedup.test.js": "import { unique } from '../src/array-dedup.js';\nconst res = unique([1, 2, 2, 3, 1]);\nif (res.length !== 3) process.exit(1);\nif (!res.includes(1) || !res.includes(2) || !res.includes(3)) process.exit(1);\nconsole.log('TEST_PASSED');\n",
    },
    inputPrompt: "Fix src/array-dedup.js to return unique elements from an array.",
    allowedTools: ["read_file", "write_file"],
    resourceLimits: { timeoutMs: 150000, stepTimeoutMs: 35000, maxSteps: 4, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTool: "write_file",
      expectedTargetFiles: ["src/array-dedup.js"],
    },
    gateBCriteria: {
      verifierType: "TEST_RUNNER",
      expectedFiles: {
        "src/array-dedup.js": (c: string) => c.includes("Set") || c.includes("filter") || c.includes("indexOf"),
      },
      immutableFiles: ["test/array-dedup.test.js"],
      testRunner: {
        targetModule: "src/array-dedup.js",
        testAssertions: `
          const r1 = unique([1, 2, 2, 3, 1]);
          if (r1.length !== 3 || r1[0] !== 1 || r1[1] !== 2 || r1[2] !== 3) throw new Error("unique elements or order failed");
          const r2 = unique([]);
          if (!Array.isArray(r2) || r2.length !== 0) throw new Error("empty array unique failed");
          const r3 = unique(["a", "b", "a", "c"]);
          if (r3.length !== 3 || r3[0] !== "a" || r3[1] !== "b" || r3[2] !== "c") throw new Error("string array unique failed");
          const r4 = unique([7, 7, 7]);
          if (r4.length !== 1 || r4[0] !== 7) throw new Error("identical elements unique failed");
        `,
      },
    },
  },
  {
    taskId: "g4-repair-04-fix-string-trim",
    gateId: "G4_SINGLE_FILE_REPAIR",
    title: "Repair String Trim Prefix Function",
    description: "Fix bug in string-prefix.js removing wrong characters.",
    version: "1.1.0",
    initialFiles: {
      "src/string-prefix.js": "export function trimPrefix(str, prefix) {\n  return str;\n}\n",
      "test/string-prefix.test.js": "import { trimPrefix } from '../src/string-prefix.js';\nif (trimPrefix('v1.2.3', 'v') !== '1.2.3') process.exit(1);\nif (trimPrefix('hello', 'x') !== 'hello') process.exit(1);\nconsole.log('TEST_PASSED');\n",
    },
    inputPrompt: "Fix src/string-prefix.js so trimPrefix removes prefix only when present.",
    allowedTools: ["read_file", "write_file"],
    resourceLimits: { timeoutMs: 150000, stepTimeoutMs: 35000, maxSteps: 4, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTool: "write_file",
      expectedTargetFiles: ["src/string-prefix.js"],
    },
    gateBCriteria: {
      verifierType: "TEST_RUNNER",
      expectedFiles: {
        "src/string-prefix.js": (c: string) => c.includes("startsWith") || c.includes("slice") || c.includes("substring"),
      },
      immutableFiles: ["test/string-prefix.test.js"],
      testRunner: {
        targetModule: "src/string-prefix.js",
        testAssertions: `
          if (trimPrefix("v1.2.3", "v") !== "1.2.3") throw new Error("trimPrefix single char failed");
          if (trimPrefix("hello world", "hello ") !== "world") throw new Error("trimPrefix multi char failed");
          if (trimPrefix("hello", "x") !== "hello") throw new Error("trimPrefix non-matching failed");
          if (trimPrefix("", "foo") !== "") throw new Error("trimPrefix empty string failed");
          if (trimPrefix("exact", "exact") !== "") throw new Error("trimPrefix complete match failed");
          if (trimPrefix("pre", "prefixLong") !== "pre") throw new Error("trimPrefix longer prefix failed");
        `,
      },
    },
  },
  {
    taskId: "g4-repair-05-fix-hex-validator",
    gateId: "G4_SINGLE_FILE_REPAIR",
    title: "Repair Hexadecimal String Validator",
    description: "Fix bug in hex-validator.js accepting non-hex characters.",
    version: "1.1.0",
    initialFiles: {
      "src/hex.js": "export function isHex(str) {\n  return str.length > 0;\n}\n",
      "test/hex.test.js": "import { isHex } from '../src/hex.js';\nif (!isHex('deadbeef')) process.exit(1);\nif (isHex('not-hex!')) process.exit(1);\nconsole.log('TEST_PASSED');\n",
    },
    inputPrompt: "Fix src/hex.js to validate that a string contains only valid hex characters.",
    allowedTools: ["read_file", "write_file"],
    resourceLimits: { timeoutMs: 150000, stepTimeoutMs: 35000, maxSteps: 4, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTool: "write_file",
      expectedTargetFiles: ["src/hex.js"],
    },
    gateBCriteria: {
      verifierType: "TEST_RUNNER",
      expectedFiles: {
        "src/hex.js": (c: string) => c.includes("test") || c.includes("match") || c.includes("[0-9a-fA-F]"),
      },
      immutableFiles: ["test/hex.test.js"],
      testRunner: {
        targetModule: "src/hex.js",
        testAssertions: `
          if (!isHex("deadbeef")) throw new Error("valid lowercase hex failed");
          if (!isHex("DEADBEEF")) throw new Error("valid uppercase hex failed");
          if (!isHex("0123456789abcdefABCDEF")) throw new Error("full hex charset failed");
          if (isHex("not-hex!")) throw new Error("non-hex characters accepted");
          if (isHex("")) throw new Error("empty string accepted");
          if (isHex("0xdeadbeef")) throw new Error("0x prefix accepted without specification");
          if (isHex("dead beef")) throw new Error("whitespace accepted");
        `,
      },
    },
  },

  // ==========================================================================
  // G5: MULTI-FILE REPAIR
  // ==========================================================================
  {
    taskId: "g5-multi-01-interface-and-impl",
    gateId: "G5_MULTI_FILE_REPAIR",
    title: "Coordinated Interface and Service Extension",
    description: "Add a status code to contract enum in types.js and implement its handling in service.js.",
    version: "1.0.0",
    initialFiles: {
      "src/types.js": "export const TaskStatus = Object.freeze({\n  PENDING: 'PENDING',\n  RUNNING: 'RUNNING',\n});\n",
      "src/service.js": "import { TaskStatus } from './types.js';\nexport function isTerminal(status) {\n  return status === 'COMPLETED' || status === 'FAILED';\n}\n",
      "test/service.test.js": "import { TaskStatus } from '../src/types.js';\nimport { isTerminal } from '../src/service.js';\nif (!TaskStatus.COMPLETED || !TaskStatus.FAILED) process.exit(1);\nif (!isTerminal(TaskStatus.COMPLETED)) process.exit(1);\nif (isTerminal(TaskStatus.RUNNING)) process.exit(1);\nconsole.log('TEST_PASSED');\n",
    },
    inputPrompt: "Update src/types.js to add COMPLETED and FAILED statuses, and update src/service.js to import and use them.",
    allowedTools: ["read_file", "write_file"],
    resourceLimits: { timeoutMs: 60000, maxSteps: 6, maxOutputBytes: 32768 },
    gateACriteria: {
      expectedTool: "write_file",
      expectedTargetFiles: ["src/types.js", "src/service.js"],
    },
    gateBCriteria: {
      verifierType: "TEST_RUNNER",
      expectedFiles: {
        "src/types.js": (c: string) => c.includes("COMPLETED") && c.includes("FAILED"),
        "src/service.js": (c: string) => c.includes("TaskStatus.COMPLETED") || c.includes("TaskStatus.FAILED"),
      },
      immutableFiles: ["test/service.test.js"],
    },
  },
  {
    taskId: "g5-multi-02-model-and-migration",
    gateId: "G5_MULTI_FILE_REPAIR",
    title: "Coordinated Model Schema and Serializer",
    description: "Add an 'email' field to both user model and serializer.",
    version: "1.0.0",
    initialFiles: {
      "src/user-model.js": "export function createUser(name) {\n  return { name };\n}\n",
      "src/serializer.js": "export function serializeUser(user) {\n  return JSON.stringify({ name: user.name });\n}\n",
      "test/user.test.js": "import { createUser } from '../src/user-model.js';\nimport { serializeUser } from '../src/serializer.js';\nconst u = createUser('Alice', 'alice@test.com');\nconst s = JSON.parse(serializeUser(u));\nif (s.name !== 'Alice' || s.email !== 'alice@test.com') process.exit(1);\nconsole.log('TEST_PASSED');\n",
    },
    inputPrompt: "Update both src/user-model.js and src/serializer.js so that user objects support an email field.",
    allowedTools: ["read_file", "write_file"],
    resourceLimits: { timeoutMs: 60000, maxSteps: 6, maxOutputBytes: 32768 },
    gateACriteria: {
      expectedTool: "write_file",
      expectedTargetFiles: ["src/user-model.js", "src/serializer.js"],
    },
    gateBCriteria: {
      verifierType: "TEST_RUNNER",
      expectedFiles: {
        "src/user-model.js": (c: string) => c.includes("email"),
        "src/serializer.js": (c: string) => c.includes("email"),
      },
      immutableFiles: ["test/user.test.js"],
    },
  },
  {
    taskId: "g5-multi-03-config-and-client",
    gateId: "G5_MULTI_FILE_REPAIR",
    title: "Coordinated Client Config and Request Builder",
    description: "Add timeout setting to client configuration and wire it to request generator.",
    version: "1.0.0",
    initialFiles: {
      "src/config.js": "export const DEFAULT_CONFIG = { retries: 3 };\n",
      "src/client.js": "import { DEFAULT_CONFIG } from './config.js';\nexport function buildRequest(url) {\n  return { url, retries: DEFAULT_CONFIG.retries };\n}\n",
      "test/client.test.js": "import { DEFAULT_CONFIG } from '../src/config.js';\nimport { buildRequest } from '../src/client.js';\nif (typeof DEFAULT_CONFIG.timeoutMs !== 'number') process.exit(1);\nconst req = buildRequest('https://example.com');\nif (typeof req.timeoutMs !== 'number') process.exit(1);\nconsole.log('TEST_PASSED');\n",
    },
    inputPrompt: "Update src/config.js to add default timeoutMs: 5000, and update src/client.js to pass timeoutMs in buildRequest.",
    allowedTools: ["read_file", "write_file"],
    resourceLimits: { timeoutMs: 60000, maxSteps: 6, maxOutputBytes: 32768 },
    gateACriteria: {
      expectedTool: "write_file",
      expectedTargetFiles: ["src/config.js", "src/client.js"],
    },
    gateBCriteria: {
      verifierType: "TEST_RUNNER",
      expectedFiles: {
        "src/config.js": (c: string) => c.includes("timeoutMs"),
        "src/client.js": (c: string) => c.includes("timeoutMs"),
      },
      immutableFiles: ["test/client.test.js"],
    },
  },

  // ==========================================================================
  // G6: REGRESSION AWARENESS
  // ==========================================================================
  {
    taskId: "g6-regr-01-preserve-existing-suite",
    gateId: "G6_REGRESSION_AWARENESS",
    title: "Fix Failing Edge Case Without Regressing Existing Tests",
    description: "Support zero and negative numbers in factorial while preserving all positive integer tests.",
    version: "1.0.0",
    initialFiles: {
      "src/factorial.js": "export function factorial(n) {\n  if (n <= 1) return 1;\n  return n * factorial(n - 1);\n}\n",
      "test/existing.test.js": "import { factorial } from '../src/factorial.js';\nif (factorial(1) !== 1) process.exit(1);\nif (factorial(3) !== 6) process.exit(1);\nif (factorial(5) !== 120) process.exit(1);\nconsole.log('EXISTING_TESTS_PASS');\n",
      "test/new-requirement.test.js": "import { factorial } from '../src/factorial.js';\nif (factorial(0) !== 1) process.exit(1);\ntry { factorial(-1); process.exit(1); } catch (e) { /* expected */ }\nconsole.log('NEW_REQUIREMENT_PASS');\n",
    },
    inputPrompt: "Fix src/factorial.js so that negative inputs throw an Error and factorial(0) === 1, without breaking existing tests.",
    allowedTools: ["read_file", "write_file"],
    resourceLimits: { timeoutMs: 45000, maxSteps: 4, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTool: "write_file",
      expectedTargetFiles: ["src/factorial.js"],
    },
    gateBCriteria: {
      verifierType: "TEST_RUNNER",
      expectedFiles: {
        "src/factorial.js": (c: string) => c.includes("< 0") || c.includes("throw"),
      },
      immutableFiles: ["test/existing.test.js", "test/new-requirement.test.js"],
    },
  },
  {
    taskId: "g6-regr-02-calculator-preserve-basics",
    gateId: "G6_REGRESSION_AWARENESS",
    title: "Add Modulo to Calculator Without Breaking Arithmetic",
    description: "Add modulo operator to calculator while ensuring addition, subtraction, multiplication remain intact.",
    version: "1.0.0",
    initialFiles: {
      "src/calc.js": "export function calculate(op, a, b) {\n  if (op === 'add') return a + b;\n  if (op === 'sub') return a - b;\n  if (op === 'mul') return a * b;\n  throw new Error('Unknown op');\n}\n",
      "test/existing.test.js": "import { calculate } from '../src/calc.js';\nif (calculate('add', 2, 3) !== 5) process.exit(1);\nif (calculate('sub', 5, 2) !== 3) process.exit(1);\nif (calculate('mul', 4, 3) !== 12) process.exit(1);\nconsole.log('EXISTING_PASS');\n",
      "test/new.test.js": "import { calculate } from '../src/calc.js';\nif (calculate('mod', 10, 3) !== 1) process.exit(1);\nconsole.log('NEW_PASS');\n",
    },
    inputPrompt: "Add support for 'mod' operation to src/calc.js while preserving add, sub, mul.",
    allowedTools: ["read_file", "write_file"],
    resourceLimits: { timeoutMs: 45000, maxSteps: 4, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTool: "write_file",
      expectedTargetFiles: ["src/calc.js"],
    },
    gateBCriteria: {
      verifierType: "TEST_RUNNER",
      expectedFiles: {
        "src/calc.js": (c: string) => c.includes("'mod'") && c.includes("%"),
      },
      immutableFiles: ["test/existing.test.js", "test/new.test.js"],
    },
  },
  {
    taskId: "g6-regr-03-parser-preserve-legacy",
    gateId: "G6_REGRESSION_AWARENESS",
    title: "Support ISO Dates Without Breaking Unix Timestamps",
    description: "Extend date parser to accept ISO strings while continuing to parse integer timestamps correctly.",
    version: "1.0.0",
    initialFiles: {
      "src/date-parser.js": "export function parseDate(input) {\n  if (typeof input === 'number') return new Date(input);\n  throw new Error('Unsupported');\n}\n",
      "test/existing.test.js": "import { parseDate } from '../src/date-parser.js';\nconst d = parseDate(1600000000000);\nif (d.getTime() !== 1600000000000) process.exit(1);\nconsole.log('EXISTING_PASS');\n",
      "test/new.test.js": "import { parseDate } from '../src/date-parser.js';\nconst d = parseDate('2020-01-01T00:00:00.000Z');\nif (isNaN(d.getTime())) process.exit(1);\nconsole.log('NEW_PASS');\n",
    },
    inputPrompt: "Extend src/date-parser.js to accept ISO date strings without breaking numeric timestamp support.",
    allowedTools: ["read_file", "write_file"],
    resourceLimits: { timeoutMs: 45000, maxSteps: 4, maxOutputBytes: 16384 },
    gateACriteria: {
      expectedTool: "write_file",
      expectedTargetFiles: ["src/date-parser.js"],
    },
    gateBCriteria: {
      verifierType: "TEST_RUNNER",
      expectedFiles: {
        "src/date-parser.js": (c: string) => c.includes("string") && c.includes("number"),
      },
      immutableFiles: ["test/existing.test.js", "test/new.test.js"],
    },
  },

  // ==========================================================================
  // G7: BEHAVIORAL CONSISTENCY (TEMP 0 STABILITY)
  // ==========================================================================
  {
    taskId: "g7-cons-01-deterministic-proposal",
    gateId: "G7_BEHAVIORAL_CONSISTENCY",
    title: "Deterministic Tool Call at Temperature 0",
    description: "Asserts 100% hash equality across repeated requests for identical context snapshot.",
    version: "1.0.0",
    initialFiles: {
      "src/index.js": "console.log('target module');",
    },
    inputPrompt: "Generate a read_file action proposal for src/index.js.",
    allowedTools: ["read_file"],
    resourceLimits: { timeoutMs: 30000, maxSteps: 1, maxOutputBytes: 8192 },
    gateACriteria: {
      expectedTool: "read_file",
      expectedTargetFiles: ["src/index.js"],
    },
    gateBCriteria: {
      verifierType: "HASH_INVARIANT",
    },
  },
  {
    taskId: "g7-cons-02-reproducible-code-edit",
    gateId: "G7_BEHAVIORAL_CONSISTENCY",
    title: "Deterministic Code Edit Proposal at Temperature 0",
    description: "Asserts identical edit payload hash across 3 independent temperature 0 invocations.",
    version: "1.0.0",
    initialFiles: {
      "src/constant.js": "export const VERSION = '1.0.0';\n",
    },
    inputPrompt: "Propose a write_file to bump VERSION to '1.0.1' in src/constant.js.",
    allowedTools: ["write_file"],
    resourceLimits: { timeoutMs: 30000, maxSteps: 1, maxOutputBytes: 8192 },
    gateACriteria: {
      expectedTool: "write_file",
      expectedTargetFiles: ["src/constant.js"],
    },
    gateBCriteria: {
      verifierType: "HASH_INVARIANT",
    },
  },
  {
    taskId: "g7-cons-03-structural-stability",
    gateId: "G7_BEHAVIORAL_CONSISTENCY",
    title: "Deterministic Action Proposal Schema at Temperature 0",
    description: "Asserts exact match in action proposal structure across repeated replays.",
    version: "1.0.0",
    initialFiles: {
      "src/config.json": "{\"debug\": false}\n",
    },
    inputPrompt: "Read src/config.json using read_file.",
    allowedTools: ["read_file"],
    resourceLimits: { timeoutMs: 30000, maxSteps: 1, maxOutputBytes: 8192 },
    gateACriteria: {
      expectedTool: "read_file",
      expectedTargetFiles: ["src/config.json"],
    },
    gateBCriteria: {
      verifierType: "HASH_INVARIANT",
    },
  },

  // ==========================================================================
  // G9: FAILURE RECOVERY
  // ==========================================================================
  {
    taskId: "g9-recov-01-file-not-found-shift",
    gateId: "G9_FAILURE_RECOVERY",
    title: "Recover from File-Not-Found Error",
    description: "When read_file fails with ENOENT on non-existent file, switch approach to search or list.",
    version: "1.0.0",
    initialFiles: {
      "src/actual-auth-module.js": "export const auth = true;",
    },
    inputPrompt: "Locate and read the auth module. Note: src/auth.js does not exist; find the real file if a read fails.",
    allowedTools: ["read_file", "search_code"],
    resourceLimits: { timeoutMs: 45000, maxSteps: 3, maxOutputBytes: 16384 },
    gateACriteria: {
      requireActionShift: true,
      expectedTargetFiles: ["src/actual-auth-module.js"],
    },
    gateBCriteria: {
      verifierType: "CLEANROOM_ORACLE",
    },
  },
  {
    taskId: "g9-recov-02-permission-denied-shift",
    gateId: "G9_FAILURE_RECOVERY",
    title: "Recover from Capability Denied Rejection",
    description: "When an unauthorized tool execution is rejected, switch to an authorized alternative.",
    version: "1.0.0",
    initialFiles: {
      "src/data.txt": "Secret data content",
    },
    inputPrompt: "Inspect src/data.txt. If run_command is denied, use read_file.",
    allowedTools: ["read_file"],
    resourceLimits: { timeoutMs: 45000, maxSteps: 3, maxOutputBytes: 16384 },
    gateACriteria: {
      requireActionShift: true,
      expectedTool: "read_file",
      expectedTargetFiles: ["src/data.txt"],
    },
    gateBCriteria: {
      verifierType: "CLEANROOM_ORACLE",
    },
  },
  {
    taskId: "g9-recov-03-syntax-error-correction",
    gateId: "G9_FAILURE_RECOVERY",
    title: "Recover from Syntax Error in Previous Attempt",
    description: "After a syntax check failure, change replacement parameters to produce valid code.",
    version: "1.0.0",
    initialFiles: {
      "src/target.js": "export function hello() {\n  return 'hello';\n}\n",
    },
    inputPrompt: "Update src/target.js to add an export named 'world'. If the first attempt is malformed, correct the syntax.",
    allowedTools: ["write_file", "read_file"],
    resourceLimits: { timeoutMs: 45000, maxSteps: 3, maxOutputBytes: 16384 },
    gateACriteria: {
      requireActionShift: true,
      expectedTool: "write_file",
      expectedTargetFiles: ["src/target.js"],
    },
    gateBCriteria: {
      verifierType: "TEST_RUNNER",
      expectedFiles: {
        "src/target.js": (c: string) => c.includes("world") && !c.includes("syntax_error"),
      },
    },
  },
  {
    taskId: "g9-recov-04-command-failure-remedy",
    gateId: "G9_FAILURE_RECOVERY",
    title: "Remedy Code Following Test Exit Failure",
    description: "Observe failing test output and modify source file rather than blindly re-running.",
    version: "1.0.0",
    initialFiles: {
      "src/status.js": "export const ready = false;\n",
      "test/status.test.js": "import { ready } from '../src/status.js';\nif (!ready) process.exit(1);\nconsole.log('PASS');\n",
    },
    inputPrompt: "Make test/status.test.js pass by updating src/status.js.",
    allowedTools: ["read_file", "write_file"],
    resourceLimits: { timeoutMs: 45000, maxSteps: 3, maxOutputBytes: 16384 },
    gateACriteria: {
      requireActionShift: true,
      expectedTool: "write_file",
      expectedTargetFiles: ["src/status.js"],
    },
    gateBCriteria: {
      verifierType: "TEST_RUNNER",
      expectedFiles: {
        "src/status.js": (c: string) => c.includes("true"),
      },
    },
  },
  {
    taskId: "g9-recov-05-argument-rejection-recovery",
    gateId: "G9_FAILURE_RECOVERY",
    title: "Recover from Schema Validation Failure",
    description: "When tool proposal is rejected due to malformed arguments, provide schema-valid arguments.",
    version: "1.0.0",
    initialFiles: {
      "src/info.txt": "Application v2.0",
    },
    inputPrompt: "Read src/info.txt with read_file using path parameter.",
    allowedTools: ["read_file"],
    resourceLimits: { timeoutMs: 45000, maxSteps: 3, maxOutputBytes: 16384 },
    gateACriteria: {
      requireActionShift: true,
      expectedTool: "read_file",
      expectedTargetFiles: ["src/info.txt"],
    },
    gateBCriteria: {
      verifierType: "CLEANROOM_ORACLE",
    },
  },
];

export function getBenchmarkTasksForGate(gateId: ModelCapabilityGateId): readonly DualGateEvaluationTask[] {
  return CAPABILITY_BENCHMARK_TASKS.filter((t) => t.gateId === gateId);
}

export function getBenchmarkTaskById(taskId: string): DualGateEvaluationTask | undefined {
  return CAPABILITY_BENCHMARK_TASKS.find((t) => t.taskId === taskId);
}
