/**
 * Deterministic Evaluation Fixture Model Provider for Emerald Agent Fabric.
 *
 * Implements a hermetic, ₹0-cost fixture model provider for clean-room dual-gate evaluation.
 * Returns deterministic action proposals tuned to benchmark tasks, supporting both positive
 * (passing Gate A and Gate B) and deliberate defect/negative trials for rigorous evaluation testing.
 */

import { ModelProviderPort, ModelProviderRequest, ModelProviderResponse } from "../../ports/model-provider.port.js";

export interface FixtureModelConfig {
  readonly mode?:
    | "ALL_PASS"
    | "FAIL_GATE_A"
    | "FAIL_GATE_B"
    | "SIMULATE_TIMEOUT"
    | "SIMULATE_PATH_TRAVERSAL"
    | "SEARCH_ONLY_NO_READ"
    | "READ_DECOY"
    | "EXHAUST_STEP_BUDGET"
    | "SIMULATE_STAGNATION";
  readonly navigationStrategy?: "SINGLE_STEP" | "MULTI_STEP";
}

export class DeterministicEvalFixtureModelProvider implements ModelProviderPort {
  readonly providerName = "deterministic-eval-fixture";

  constructor(private readonly config: FixtureModelConfig = {}) {}

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    if (this.config.mode === "SIMULATE_TIMEOUT") {
      // Delay longer than any reasonable test timeout
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }

    const reply = (payload: unknown): ModelProviderResponse => ({
      requestId: request.requestId,
      model: request.model,
      outputText: JSON.stringify(payload),
      finishReason: "STOP",
      durationMs: 25,
    });

    if (this.config.mode === "SIMULATE_PATH_TRAVERSAL") {
      const payload = {
        toolName: "read_file",
        inputPayload: { path: "../../../etc/passwd" },
        rationale: "Attempting illegal traversal outside sandbox",
      };
      return reply(payload);
    }

    if (this.config.mode === "SIMULATE_STAGNATION") {
      const payload = {
        toolName: "search_code",
        inputPayload: { query: "signToken" },
        rationale: "Repeated search proposal for stagnation test",
      };
      return reply(payload);
    }

    if (this.config.mode === "EXHAUST_STEP_BUDGET") {
      const payload = {
        toolName: "search_code",
        inputPayload: { query: `exhaust-query-${request.input.length}` },
        rationale: "Executing repeated search without reading file",
      };
      return reply(payload);
    }

    const lastMessage = request.input[request.input.length - 1]?.content ?? "";

    // Terminal completion if prior step was read_file or write_file
    if (lastMessage.includes("Tool 'read_file' observation") || lastMessage.includes("Tool 'write_file' observation")) {
      return reply({
        toolName: undefined,
        rationale: "Navigation and verification complete.",
      });
    }

    // Step 2 for multi-step search_code observation
    if (lastMessage.includes("Tool 'search_code' observation")) {
      if (this.config.mode === "SEARCH_ONLY_NO_READ" || this.config.mode === "FAIL_GATE_B") {
        return reply({
          toolName: undefined,
          rationale: "I have verified packages/services/auth/src/jwt-signer.js and signToken and all tests pass from search results without reading.",
        });
      }

      if (this.config.mode === "READ_DECOY") {
        return reply({
          toolName: "read_file",
          inputPayload: { path: "docs/sample-config.json" },
          rationale: "Comparing with config/production.json and prod-aurora-cluster, but mistakenly reading docs/sample-config.json",
        });
      }

      if (lastMessage.includes("jwt-signer.js")) {
        return reply({
          toolName: "read_file",
          inputPayload: { path: "packages/services/auth/src/jwt-signer.js" },
          rationale: "Found token signing in jwt-signer.js and inspecting signToken signature",
        });
      }

      if (lastMessage.includes("pool.js")) {
        return reply({
          toolName: "read_file",
          inputPayload: { path: "src/infra/db/pool.js" },
          rationale: "Found createPool in src/infra/db/pool.js",
        });
      }

      if (lastMessage.includes("logger.js")) {
        return reply({
          toolName: "read_file",
          inputPayload: { path: "src/middleware/logger.js" },
          rationale: "Found requestLogger in src/middleware/logger.js",
        });
      }

      if (lastMessage.includes("global-error.js")) {
        return reply({
          toolName: "read_file",
          inputPayload: { path: "src/handlers/errors/global-error.js" },
          rationale: "Found errorHandler in src/handlers/errors/global-error.js",
        });
      }

      if (lastMessage.includes("production.json")) {
        return reply({
          toolName: "read_file",
          inputPayload: { path: "config/production.json" },
          rationale: "Found active prod-aurora-cluster in config/production.json",
        });
      }

      return reply({
        toolName: "read_file",
        inputPayload: { path: "README.md" },
        rationale: "Fallback read proposal",
      });
    }

    // Step 1: Initial user prompt responses
    const isSingleStep = this.config.navigationStrategy === "SINGLE_STEP";

    // G2 Repository Navigation responses
    if (lastMessage.includes("token signing implementation")) {
      if (this.config.mode === "FAIL_GATE_A") {
        return reply({
          toolName: "read_file",
          inputPayload: { path: "packages/services/users/src/user-store.js" },
          rationale: "Inspecting users",
        });
      }
      if (isSingleStep) {
        return reply({
          toolName: "read_file",
          inputPayload: { path: "packages/services/auth/src/jwt-signer.js" },
          rationale: "Found token signing in jwt-signer.js with signToken",
        });
      }
      return reply({
        toolName: "search_code",
        inputPayload: { query: "signToken" },
        rationale: "Searching for token signing function signToken in repository",
      });
    }

    if (lastMessage.includes("database connection pool")) {
      if (isSingleStep) {
        return reply({
          toolName: "read_file",
          inputPayload: { path: "src/infra/db/pool.js" },
          rationale: "Found createPool in src/infra/db/pool.js",
        });
      }
      return reply({
        toolName: "search_code",
        inputPayload: { query: "createPool" },
        rationale: "Searching for createPool database connection pool in infrastructure",
      });
    }

    if (lastMessage.includes("logging incoming HTTP requests")) {
      if (isSingleStep) {
        return reply({
          toolName: "read_file",
          inputPayload: { path: "src/middleware/logger.js" },
          rationale: "Found requestLogger in src/middleware/logger.js",
        });
      }
      return reply({
        toolName: "search_code",
        inputPayload: { query: "requestLogger" },
        rationale: "Searching for requestLogger HTTP logging middleware",
      });
    }

    if (lastMessage.includes("centralized global error handler")) {
      if (isSingleStep) {
        return reply({
          toolName: "read_file",
          inputPayload: { path: "src/handlers/errors/global-error.js" },
          rationale: "Found errorHandler in src/handlers/errors/global-error.js",
        });
      }
      return reply({
        toolName: "search_code",
        inputPayload: { query: "errorHandler" },
        rationale: "Searching for errorHandler in handlers tree",
      });
    }

    if (lastMessage.includes("production configuration")) {
      if (isSingleStep) {
        return reply({
          toolName: "read_file",
          inputPayload: { path: "config/production.json" },
          rationale: "Found active prod-aurora-cluster in config/production.json",
        });
      }
      return reply({
        toolName: "search_code",
        inputPayload: { query: "prod-aurora-cluster" },
        rationale: "Searching for active production configuration cluster prod-aurora-cluster",
      });
    }

    // G3 Code Understanding & Diagnosis responses
    if (lastMessage.includes("chunker.js") || lastMessage.includes("chunkArray")) {
      const payload = {
        toolName: "read_file",
        inputPayload: { path: "src/chunker.js" },
        rationale: "The defect is on line 3: i <= arr.length must be i < arr.length to prevent the empty final chunk in slice.",
      };
      return reply(payload);
    }

    if (lastMessage.includes("user-service.js") || lastMessage.includes("getUserDisplayName")) {
      const payload = {
        toolName: "read_file",
        inputPayload: { path: "src/user-service.js" },
        rationale: "Line 2 fails because user.profile can be undefined without null check.",
      };
      return reply(payload);
    }

    if (lastMessage.includes("computeEffectiveRate") || lastMessage.includes("rate.js")) {
      const payload = {
        toolName: "read_file",
        inputPayload: { path: "src/rate.js" },
        rationale: "Line 2 has division by zero when principal === 0 producing Infinity.",
      };
      return reply(payload);
    }

    if (lastMessage.includes("persistJob") || lastMessage.includes("worker.js")) {
      const payload = {
        toolName: "read_file",
        inputPayload: { path: "src/worker.js" },
        rationale: "Line 2 is missing await on db.save(job).",
      };
      return reply(payload);
    }

    if (lastMessage.includes("math.test.js") || lastMessage.includes("math.js")) {
      const payload = {
        toolName: "read_file",
        inputPayload: { path: "test/math.test.js" },
        rationale: "The test oracle in test/math.test.js is defective on line 3 for expecting 2+2 to equal 5; src/math.js implementation is correct.",
      };
      return reply(payload);
    }

    // G4 Single File Repair responses
    if (lastMessage.includes("math-pow.js")) {
      const fixedCode = this.config.mode === "FAIL_GATE_B"
        ? "export function power(base, exp) { return 0; }\n"
        : "export function power(base, exp) { return base ** exp; }\n";
      const payload = {
        toolName: "write_file",
        inputPayload: { path: "src/math-pow.js", content: fixedCode },
        rationale: "Fixed power computation with exponentiation operator",
      };
      return reply(payload);
    }

    if (lastMessage.includes("clamp.js")) {
      const payload = {
        toolName: "write_file",
        inputPayload: {
          path: "src/clamp.js",
          content: "export function clamp(val, min, max) {\n  if (val < min) return min;\n  if (val > max) return max;\n  return val;\n}\n",
        },
        rationale: "Corrected clamp min and max boundary checks",
      };
      return reply(payload);
    }

    if (lastMessage.includes("array-dedup.js")) {
      const payload = {
        toolName: "write_file",
        inputPayload: {
          path: "src/array-dedup.js",
          content: "export function unique(arr) {\n  return Array.from(new Set(arr));\n}\n",
        },
        rationale: "Deduplicated array using Set",
      };
      return reply(payload);
    }

    if (lastMessage.includes("string-prefix.js")) {
      const payload = {
        toolName: "write_file",
        inputPayload: {
          path: "src/string-prefix.js",
          content: "export function trimPrefix(str, prefix) {\n  return str.startsWith(prefix) ? str.slice(prefix.length) : str;\n}\n",
        },
        rationale: "Trimmed prefix using startsWith and slice",
      };
      return reply(payload);
    }

    if (lastMessage.includes("hex.js")) {
      const payload = {
        toolName: "write_file",
        inputPayload: {
          path: "src/hex.js",
          content: "export function isHex(str) {\n  return /^[0-9a-fA-F]+$/.test(str);\n}\n",
        },
        rationale: "Validated hex string with regex test",
      };
      return reply(payload);
    }

    // G5 Multi File Repair responses
    if (lastMessage.includes("types.js") || lastMessage.includes("service.js")) {
      const payload = {
        toolName: "write_file",
        inputPayload: {
          path: "src/types.js",
          content: "export const TaskStatus = Object.freeze({\n  PENDING: 'PENDING',\n  RUNNING: 'RUNNING',\n  COMPLETED: 'COMPLETED',\n  FAILED: 'FAILED',\n});\n",
        },
        rationale: "Added COMPLETED and FAILED statuses to TaskStatus in types.js",
      };
      return reply(payload);
    }

    if (lastMessage.includes("user-model.js")) {
      const payload = {
        toolName: "write_file",
        inputPayload: {
          path: "src/user-model.js",
          content: "export function createUser(name, email) {\n  return { name, email };\n}\n",
        },
        rationale: "Added email support to user-model",
      };
      return reply(payload);
    }

    if (lastMessage.includes("DEFAULT_CONFIG")) {
      const payload = {
        toolName: "write_file",
        inputPayload: {
          path: "src/config.js",
          content: "export const DEFAULT_CONFIG = { retries: 3, timeoutMs: 5000 };\n",
        },
        rationale: "Added timeoutMs to DEFAULT_CONFIG",
      };
      return reply(payload);
    }

    // G6 Regression Awareness responses
    if (lastMessage.includes("factorial.js")) {
      const payload = {
        toolName: "write_file",
        inputPayload: {
          path: "src/factorial.js",
          content: "export function factorial(n) {\n  if (n < 0) throw new Error('Negative input');\n  if (n <= 1) return 1;\n  return n * factorial(n - 1);\n}\n",
        },
        rationale: "Supported factorial(0) and threw error on negative numbers without regressing positive calculations",
      };
      return reply(payload);
    }

    if (lastMessage.includes("calc.js")) {
      const payload = {
        toolName: "write_file",
        inputPayload: {
          path: "src/calc.js",
          content: "export function calculate(op, a, b) {\n  if (op === 'add') return a + b;\n  if (op === 'sub') return a - b;\n  if (op === 'mul') return a * b;\n  if (op === 'mod') return a % b;\n  throw new Error('Unknown op');\n}\n",
        },
        rationale: "Added mod operation without breaking arithmetic",
      };
      return reply(payload);
    }

    if (lastMessage.includes("date-parser.js")) {
      const payload = {
        toolName: "write_file",
        inputPayload: {
          path: "src/date-parser.js",
          content: "export function parseDate(input) {\n  if (typeof input === 'number') return new Date(input);\n  if (typeof input === 'string') return new Date(input);\n  throw new Error('Unsupported');\n}\n",
        },
        rationale: "Extended date parser for ISO strings while preserving numeric timestamps",
      };
      return reply(payload);
    }

    // G7 Behavioral Consistency responses
    if (lastMessage.includes("src/index.js")) {
      const payload = {
        toolName: "read_file",
        inputPayload: { path: "src/index.js" },
        rationale: "Reading src/index.js stably",
      };
      return reply(payload);
    }

    if (lastMessage.includes("VERSION")) {
      const payload = {
        toolName: "write_file",
        inputPayload: { path: "src/constant.js", content: "export const VERSION = '1.0.1';\n" },
        rationale: "Bumped VERSION to 1.0.1",
      };
      return reply(payload);
    }

    if (lastMessage.includes("src/config.json")) {
      const payload = {
        toolName: "read_file",
        inputPayload: { path: "src/config.json" },
        rationale: "Reading config cleanly",
      };
      return reply(payload);
    }

    // G9 Failure Recovery responses
    if (lastMessage.includes("actual-auth-module.js")) {
      const payload = {
        toolName: "read_file",
        inputPayload: { path: "src/actual-auth-module.js" },
        rationale: "Switched target to src/actual-auth-module.js after finding non-existent path",
      };
      return reply(payload);
    }

    if (lastMessage.includes("src/data.txt")) {
      const payload = {
        toolName: "read_file",
        inputPayload: { path: "src/data.txt" },
        rationale: "Switched to read_file on src/data.txt",
      };
      return reply(payload);
    }

    if (lastMessage.includes("src/target.js")) {
      const payload = {
        toolName: "write_file",
        inputPayload: {
          path: "src/target.js",
          content: "export function hello() {\n  return 'hello';\n}\nexport const world = 'world';\n",
        },
        rationale: "Corrected syntax for world export in src/target.js",
      };
      return reply(payload);
    }

    if (lastMessage.includes("status.js")) {
      const payload = {
        toolName: "write_file",
        inputPayload: {
          path: "src/status.js",
          content: "export const ready = true;\n",
        },
        rationale: "Set ready to true to make test pass",
      };
      return reply(payload);
    }

    if (lastMessage.includes("src/info.txt")) {
      const payload = {
        toolName: "read_file",
        inputPayload: { path: "src/info.txt" },
        rationale: "Providing schema-valid arguments for read_file on src/info.txt",
      };
      return reply(payload);
    }

    // Generic fallback proposal
    const fallback = {
      toolName: "read_file",
      inputPayload: { path: "README.md" },
      rationale: "Default fixture proposal",
    };
    return reply(fallback);
  }
}
