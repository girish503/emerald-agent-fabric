import { describe, expect, it } from "vitest";
import {
  DomainError,
  INITIAL_TOOL_DEFINITIONS,
  InvalidToolInputError,
  isValidToolName,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  SEARCH_CODE_TOOL,
  GIT_STATUS_TOOL,
  GIT_DIFF_TOOL,
  RUN_COMMAND_TOOL,
  ReadFileInputSchema,
  ReadFileOutputSchema,
  WriteFileInputSchema,
  WriteFileOutputSchema,
  SearchCodeInputSchema,
  SearchCodeOutputSchema,
  GitStatusInputSchema,
  GitStatusOutputSchema,
  GitDiffInputSchema,
  GitDiffOutputSchema,
  RunCommandInputSchema,
  RunCommandOutputSchema,
  StaticToolRegistry,
  staticToolRegistry,
  TOOL_CAPABILITY_MAP,
  KNOWN_TOOL_CAPABILITIES,
  toolNameToCapabilityName,
  TOOL_ERROR_CATEGORY_MAP,
  TOOL_ERROR_CODES,
  TOOL_IDEMPOTENCY_MAP,
  TOOL_ISOLATION_MAP,
  TOOL_NAMES,
  ToolCancelledError,
  ToolCapabilityDeniedError,
  ToolDomainError,
  ToolExecutionFailedError,
  ToolNotFoundError,
  ToolOutputLimitExceededError,
  ToolProviderUnavailableError,
  ToolRequest,
  ToolResult,
  ToolTimeoutError,
  ToolWorkspaceBoundaryViolationError,
} from "../../src/domain/index.js";
import { createCapability } from "../../src/domain/capability.js";

describe("Phase 4 / Task 4.1: Typed Tool Domain Contracts, Schemas & Error Taxonomy", () => {
  // =========================================================================
  // 1. Tool Identity & Catalog
  // =========================================================================
  describe("1. Tool Identity & Catalog", () => {
    it("defines exactly the six initial tools with stable names", () => {
      expect(TOOL_NAMES).toHaveLength(7);
      expect(INITIAL_TOOL_DEFINITIONS).toHaveLength(7);
      expect(TOOL_NAMES).toEqual([
        "run_command",
        "write_file",
        "read_file",
        "search_code",
        "git_status",
        "git_diff",
        "edit_file",
      ]);
    });

    it("validates known and rejects arbitrary tool names", () => {
      expect(isValidToolName("read_file")).toBe(true);
      expect(isValidToolName("write_file")).toBe(true);
      expect(isValidToolName("search_code")).toBe(true);
      expect(isValidToolName("git_status")).toBe(true);
      expect(isValidToolName("git_diff")).toBe(true);
      expect(isValidToolName("run_command")).toBe(true);

      expect(isValidToolName("read")).toBe(false);
      expect(isValidToolName("write")).toBe(false);
      expect(isValidToolName("shell")).toBe(false);
      expect(isValidToolName("exec")).toBe(false);
      expect(isValidToolName("bash")).toBe(false);
      expect(isValidToolName("delete_file")).toBe(false);
      expect(isValidToolName("")).toBe(false);
    });

    it("registers all six tools in StaticToolRegistry reference catalog", () => {
      expect(staticToolRegistry.listTools()).toHaveLength(7);
      for (const name of TOOL_NAMES) {
        expect(staticToolRegistry.hasTool(name)).toBe(true);
        const tool = staticToolRegistry.getTool(name);
        expect(tool).toBeDefined();
        expect(tool?.name).toBe(name);
        expect(tool?.version).toBe("1.0.0");
      }
    });

    it("returns null when resolving an unknown tool name from registry", () => {
      expect(staticToolRegistry.getTool("unknown_tool")).toBeNull();
      expect(staticToolRegistry.getTool("execute_bash")).toBeNull();
      expect(staticToolRegistry.hasTool("unknown_tool")).toBe(false);
    });

    it("rejects duplicate tool definitions when constructing StaticToolRegistry", () => {
      expect(() => {
        new StaticToolRegistry([READ_FILE_TOOL, READ_FILE_TOOL]);
      }).toThrow(/Duplicate tool definition for 'read_file'/);
    });
  });

  // =========================================================================
  // 2. Capability Mapping & Authority Separation
  // =========================================================================
  describe("2. Capability Mapping & Authority Separation", () => {
    it("maps all tools deterministically to pure capability strings", () => {
      expect(TOOL_CAPABILITY_MAP.read_file).toBe("workspace.file.read");
      expect(TOOL_CAPABILITY_MAP.write_file).toBe("workspace.file.write");
      expect(TOOL_CAPABILITY_MAP.search_code).toBe("workspace.code.search");
      expect(TOOL_CAPABILITY_MAP.git_status).toBe("git.read");
      expect(TOOL_CAPABILITY_MAP.git_diff).toBe("git.read");
      expect(TOOL_CAPABILITY_MAP.run_command).toBe("process.execute");
    });

    it("resolves tool names via toolNameToCapabilityName", () => {
      expect(toolNameToCapabilityName("read_file")).toBe("workspace.file.read");
      expect(toolNameToCapabilityName("write_file")).toBe("workspace.file.write");
      expect(toolNameToCapabilityName("search_code")).toBe("workspace.code.search");
      expect(toolNameToCapabilityName("git_status")).toBe("git.read");
      expect(toolNameToCapabilityName("git_diff")).toBe("git.read");
      expect(toolNameToCapabilityName("run_command")).toBe("process.execute");
      expect(toolNameToCapabilityName("unrecognized")).toBeNull();
    });

    it("exposes unique KNOWN_TOOL_CAPABILITIES list", () => {
      expect(KNOWN_TOOL_CAPABILITIES).toEqual([
        "workspace.file.read",
        "workspace.file.write",
        "workspace.code.search",
        "git.read",
        "process.execute",
      ]);
    });

    it("creates validated Capability aggregates from tool capabilities", () => {
      for (const name of TOOL_NAMES) {
        const capString = TOOL_CAPABILITY_MAP[name];
        const cap = createCapability(capString);
        expect(cap.name).toBe(capString);
        expect(cap.version).toBe("1.0");
      }
    });

    it("ensures every tool definition declares the expected requiredCapability", () => {
      expect(READ_FILE_TOOL.requiredCapability).toBe("workspace.file.read");
      expect(WRITE_FILE_TOOL.requiredCapability).toBe("workspace.file.write");
      expect(SEARCH_CODE_TOOL.requiredCapability).toBe("workspace.code.search");
      expect(GIT_STATUS_TOOL.requiredCapability).toBe("git.read");
      expect(GIT_DIFF_TOOL.requiredCapability).toBe("git.read");
      expect(RUN_COMMAND_TOOL.requiredCapability).toBe("process.execute");
    });
  });

  // =========================================================================
  // 3. Idempotency Classification
  // =========================================================================
  describe("3. Idempotency Classification", () => {
    it("classifies read-only and inspection tools as IDEMPOTENT", () => {
      expect(TOOL_IDEMPOTENCY_MAP.read_file).toBe("IDEMPOTENT");
      expect(TOOL_IDEMPOTENCY_MAP.search_code).toBe("IDEMPOTENT");
      expect(TOOL_IDEMPOTENCY_MAP.git_status).toBe("IDEMPOTENT");
      expect(TOOL_IDEMPOTENCY_MAP.git_diff).toBe("IDEMPOTENT");
    });

    it("classifies state-mutating and process tools as NON_IDEMPOTENT", () => {
      expect(TOOL_IDEMPOTENCY_MAP.write_file).toBe("NON_IDEMPOTENT");
      expect(TOOL_IDEMPOTENCY_MAP.run_command).toBe("NON_IDEMPOTENT");
    });

    it("ensures every concrete tool definition declares explicit idempotency", () => {
      expect(READ_FILE_TOOL.idempotency).toBe("IDEMPOTENT");
      expect(SEARCH_CODE_TOOL.idempotency).toBe("IDEMPOTENT");
      expect(GIT_STATUS_TOOL.idempotency).toBe("IDEMPOTENT");
      expect(GIT_DIFF_TOOL.idempotency).toBe("IDEMPOTENT");
      expect(WRITE_FILE_TOOL.idempotency).toBe("NON_IDEMPOTENT");
      expect(RUN_COMMAND_TOOL.idempotency).toBe("NON_IDEMPOTENT");
    });
  });

  // =========================================================================
  // 4. Isolation Requirement
  // =========================================================================
  describe("4. Isolation Requirement", () => {
    it("confines workspace file and git tools to WORKSPACE isolation", () => {
      expect(TOOL_ISOLATION_MAP.read_file).toBe("WORKSPACE");
      expect(TOOL_ISOLATION_MAP.write_file).toBe("WORKSPACE");
      expect(TOOL_ISOLATION_MAP.search_code).toBe("WORKSPACE");
      expect(TOOL_ISOLATION_MAP.git_status).toBe("WORKSPACE");
      expect(TOOL_ISOLATION_MAP.git_diff).toBe("WORKSPACE");
    });

    it("demands SANDBOX container isolation for run_command", () => {
      expect(TOOL_ISOLATION_MAP.run_command).toBe("SANDBOX");
    });

    it("ensures every tool definition declares its required isolation boundary", () => {
      expect(READ_FILE_TOOL.isolationRequirement).toBe("WORKSPACE");
      expect(WRITE_FILE_TOOL.isolationRequirement).toBe("WORKSPACE");
      expect(SEARCH_CODE_TOOL.isolationRequirement).toBe("WORKSPACE");
      expect(GIT_STATUS_TOOL.isolationRequirement).toBe("WORKSPACE");
      expect(GIT_DIFF_TOOL.isolationRequirement).toBe("WORKSPACE");
      expect(RUN_COMMAND_TOOL.isolationRequirement).toBe("SANDBOX");
    });
  });

  // =========================================================================
  // 5. Resource Semantics & Declarations
  // =========================================================================
  describe("5. Resource Semantics & Declarations", () => {
    it("declares supported resource dimensions for each tool", () => {
      expect(READ_FILE_TOOL.resourceDescriptor.supportedDimensions).toEqual(["maxBytes"]);
      expect(WRITE_FILE_TOOL.resourceDescriptor.supportedDimensions).toEqual(["maxBytes"]);
      expect(SEARCH_CODE_TOOL.resourceDescriptor.supportedDimensions).toEqual(["maxResults", "maxBytes"]);
      expect(GIT_STATUS_TOOL.resourceDescriptor.supportedDimensions).toEqual([]);
      expect(GIT_DIFF_TOOL.resourceDescriptor.supportedDimensions).toEqual(["maxBytes"]);
      expect(RUN_COMMAND_TOOL.resourceDescriptor.supportedDimensions).toEqual(["timeoutMs", "maxOutputBytes"]);
    });

    it("preserves declared resource limits without silent clamping in schemas", () => {
      // Caller requests a high timeout - schema parses it faithfully so gateway can enforce ceilings
      const parsedCmd = RunCommandInputSchema.parse({
        argv: ["pytest"],
        timeoutMs: 120000,
        maxOutputBytes: 5000000,
      });
      expect(parsedCmd.timeoutMs).toBe(120000);
      expect(parsedCmd.maxOutputBytes).toBe(5000000);

      const parsedRead = ReadFileInputSchema.parse({
        path: "src/index.ts",
        maxBytes: 8000000,
      });
      expect(parsedRead.maxBytes).toBe(8000000);
    });

    it("rejects non-positive and invalid resource limits at schema boundary", () => {
      expect(() => ReadFileInputSchema.parse({ path: "test.txt", maxBytes: -10 })).toThrow();
      expect(() => ReadFileInputSchema.parse({ path: "test.txt", maxBytes: 0 })).toThrow();
      expect(() => ReadFileInputSchema.parse({ path: "test.txt", limitLines: -5 })).toThrow();
      expect(() => ReadFileInputSchema.parse({ path: "test.txt", limitLines: 0 })).toThrow();
      expect(() => ReadFileInputSchema.parse({ path: "test.txt", offsetLine: 0 })).toThrow();

      expect(() => SearchCodeInputSchema.parse({ query: "foo", maxResults: 0 })).toThrow();
      expect(() => SearchCodeInputSchema.parse({ query: "foo", maxResults: -1 })).toThrow();

      expect(() => RunCommandInputSchema.parse({ argv: ["ls"], timeoutMs: 0 })).toThrow();
      expect(() => RunCommandInputSchema.parse({ argv: ["ls"], timeoutMs: -1000 })).toThrow();
      expect(() => RunCommandInputSchema.parse({ argv: ["ls"], maxOutputBytes: 0 })).toThrow();
      expect(() => RunCommandInputSchema.parse({ argv: ["ls"], maxOutputBytes: -500 })).toThrow();
    });
  });

  // =========================================================================
  // 6. Tool Input Schemas & Strict Validation
  // =========================================================================
  describe("6. Tool Input Schemas & Strict Validation", () => {
    describe("read_file schema", () => {
      it("parses valid input with defaults", () => {
        const result = ReadFileInputSchema.parse({ path: "src/main.ts" });
        expect(result.path).toBe("src/main.ts");
        expect(result.offsetLine).toBe(1);
        expect(result.limitLines).toBe(500);
        expect(result.maxBytes).toBeUndefined();
      });

      it("parses valid input with explicit parameters", () => {
        const result = ReadFileInputSchema.parse({
          path: "package.json",
          offsetLine: 10,
          limitLines: 100,
          maxBytes: 50000,
        });
        expect(result.offsetLine).toBe(10);
        expect(result.limitLines).toBe(100);
        expect(result.maxBytes).toBe(50000);
      });

      it("rejects missing path", () => {
        expect(() => ReadFileInputSchema.parse({})).toThrow();
      });

      it("rejects unknown fields (.strict)", () => {
        expect(() =>
          ReadFileInputSchema.parse({ path: "file.txt", unknownProp: "bar" } as any)
        ).toThrow();
      });
    });

    describe("write_file schema", () => {
      it("parses valid input with defaults", () => {
        const result = WriteFileInputSchema.parse({
          path: "src/test.txt",
          content: "hello world",
        });
        expect(result.path).toBe("src/test.txt");
        expect(result.content).toBe("hello world");
        expect(result.overwrite).toBe(true);
      });

      it("parses valid input with explicit overwrite=false and maxBytes", () => {
        const result = WriteFileInputSchema.parse({
          path: "src/test.txt",
          content: "hello",
          overwrite: false,
          maxBytes: 1000,
        });
        expect(result.overwrite).toBe(false);
        expect(result.maxBytes).toBe(1000);
      });

      it("rejects missing content or path", () => {
        expect(() => WriteFileInputSchema.parse({ path: "a.txt" })).toThrow();
        expect(() => WriteFileInputSchema.parse({ content: "text" })).toThrow();
      });

      it("rejects unknown fields (.strict)", () => {
        expect(() =>
          WriteFileInputSchema.parse({
            path: "a.txt",
            content: "b",
            extraField: 123,
          } as any)
        ).toThrow();
      });
    });

    describe("search_code schema", () => {
      it("parses valid input with defaults", () => {
        const result = SearchCodeInputSchema.parse({ query: "function test" });
        expect(result.query).toBe("function test");
        expect(result.isRegex).toBe(false);
        expect(result.path).toBe(".");
        expect(result.filePattern).toBe("*");
        expect(result.maxResults).toBe(50);
      });

      it("rejects empty query", () => {
        expect(() => SearchCodeInputSchema.parse({ query: "" })).toThrow();
      });

      it("rejects unknown fields (.strict)", () => {
        expect(() =>
          SearchCodeInputSchema.parse({ query: "foo", unauthorizedArg: true } as any)
        ).toThrow();
      });
    });

    describe("git_status schema", () => {
      it("parses empty object and optional relative path", () => {
        const resEmpty = GitStatusInputSchema.parse({});
        expect(resEmpty).toEqual({});

        const resPath = GitStatusInputSchema.parse({ path: "packages/core" });
        expect(resPath.path).toBe("packages/core");
      });

      it("rejects unknown fields (.strict)", () => {
        expect(() =>
          GitStatusInputSchema.parse({ options: "--short" } as any)
        ).toThrow();
      });
    });

    describe("git_diff schema", () => {
      it("parses default input", () => {
        const res = GitDiffInputSchema.parse({});
        expect(res.staged).toBe(false);
        expect(res.path).toBeUndefined();
      });

      it("parses staged and maxBytes", () => {
        const res = GitDiffInputSchema.parse({ staged: true, maxBytes: 50000 });
        expect(res.staged).toBe(true);
        expect(res.maxBytes).toBe(50000);
      });

      it("rejects unknown fields (.strict)", () => {
        expect(() =>
          GitDiffInputSchema.parse({ commit: "HEAD~1" } as any)
        ).toThrow();
      });
    });
  });

  // =========================================================================
  // 7. run_command Security Critical Validation
  // =========================================================================
  describe("7. run_command Security Critical Validation", () => {
    it("parses valid discrete argv tokens", () => {
      const res = RunCommandInputSchema.parse({
        argv: ["npm", "test"],
      });
      expect(res.argv).toEqual(["npm", "test"]);
      expect(res.cwd).toBe(".");
    });

    it("parses explicit cwd, timeout, and maxOutputBytes", () => {
      const res = RunCommandInputSchema.parse({
        argv: ["git", "log", "-n", "5"],
        cwd: "subdir",
        timeoutMs: 15000,
        maxOutputBytes: 100000,
      });
      expect(res.argv).toEqual(["git", "log", "-n", "5"]);
      expect(res.cwd).toBe("subdir");
      expect(res.timeoutMs).toBe(15000);
      expect(res.maxOutputBytes).toBe(100000);
    });

    it("rejects empty argv array", () => {
      expect(() => RunCommandInputSchema.parse({ argv: [] })).toThrow(/argv must contain at least the executable/);
    });

    it("rejects empty or whitespace executable name in argv[0]", () => {
      expect(() => RunCommandInputSchema.parse({ argv: [""] })).toThrow(/Executable name/);
      expect(() => RunCommandInputSchema.parse({ argv: ["   "] })).toThrow(/Executable name/);
    });

    it("rejects non-array string command (refuses raw shell string API)", () => {
      expect(() =>
        RunCommandInputSchema.parse({ argv: "npm test" } as any)
      ).toThrow();
      expect(() =>
        RunCommandInputSchema.parse({ command: "bash -c 'npm test'" } as any)
      ).toThrow();
    });

    it("rejects unknown fields (.strict)", () => {
      expect(() =>
        RunCommandInputSchema.parse({
          argv: ["npm", "test"],
          shell: true,
        } as any)
      ).toThrow();
    });
  });

  // =========================================================================
  // 8. Malicious Path Traversal & Lexical Escape Defenses
  // =========================================================================
  describe("8. Malicious Path Traversal & Lexical Escape Defenses", () => {
    const maliciousPaths = [
      "../../etc/passwd",
      "/etc/shadow",
      "/var/run/docker.sock",
      "\\Windows\\System32\\cmd.exe",
      "C:\\boot.ini",
      "D:/secret.txt",
      "\\\\192.168.1.1\\share\\data",
      "//server/share",
      "foo\0bar.ts",
      "foo%00bar.ts",
      "CON",
      "NUL",
      "AUX",
      "COM1",
      "LPT1",
      "   leading-space.txt",
      "trailing-space.txt   ",
    ];

    it("rejects all malicious paths in read_file input", () => {
      for (const badPath of maliciousPaths) {
        expect(() => ReadFileInputSchema.parse({ path: badPath })).toThrow();
      }
    });

    it("rejects all malicious paths in write_file input", () => {
      for (const badPath of maliciousPaths) {
        expect(() =>
          WriteFileInputSchema.parse({ path: badPath, content: "malicious" })
        ).toThrow();
      }
    });

    it("rejects malicious paths in search_code directory path", () => {
      for (const badPath of maliciousPaths) {
        expect(() =>
          SearchCodeInputSchema.parse({ query: "test", path: badPath })
        ).toThrow();
      }
    });

    it("rejects malicious paths in git_status path filter", () => {
      for (const badPath of maliciousPaths) {
        expect(() => GitStatusInputSchema.parse({ path: badPath })).toThrow();
      }
    });

    it("rejects malicious paths in git_diff path filter", () => {
      for (const badPath of maliciousPaths) {
        expect(() => GitDiffInputSchema.parse({ path: badPath })).toThrow();
      }
    });

    it("rejects malicious cwd paths in run_command input", () => {
      for (const badPath of maliciousPaths) {
        expect(() =>
          RunCommandInputSchema.parse({ argv: ["ls"], cwd: badPath })
        ).toThrow();
      }
    });
  });

  // =========================================================================
  // 9. Tool Output Schemas
  // =========================================================================
  describe("9. Tool Output Schemas", () => {
    it("validates read_file output shape", () => {
      const output = ReadFileOutputSchema.parse({
        path: "src/main.ts",
        content: "export const x = 1;",
        bytesRead: 19,
        totalLines: 1,
        isTruncated: false,
        contentHash: "a".repeat(64),
      });
      expect(output.bytesRead).toBe(19);
      expect(output.isTruncated).toBe(false);
    });

    it("validates write_file output shape", () => {
      const output = WriteFileOutputSchema.parse({
        path: "src/new.ts",
        bytesWritten: 100,
        created: true,
        contentHash: "b".repeat(64),
      });
      expect(output.created).toBe(true);
      expect(output.bytesWritten).toBe(100);
    });

    it("validates search_code output shape", () => {
      const output = SearchCodeOutputSchema.parse({
        query: "export",
        matches: [
          { file: "src/a.ts", line: 10, content: "export class A {}" },
          { file: "src/b.ts", line: 20, content: "export function b() {}" },
        ],
        totalMatches: 2,
        truncated: false,
      });
      expect(output.matches).toHaveLength(2);
      expect(output.totalMatches).toBe(2);
    });

    it("validates git_status output shape", () => {
      const output = GitStatusOutputSchema.parse({
        clean: false,
        currentCommit: "c".repeat(40),
        modified: ["src/index.ts"],
        added: ["src/new.ts"],
        deleted: [],
        untracked: ["temp.log"],
      });
      expect(output.clean).toBe(false);
      expect(output.modified).toContain("src/index.ts");
    });

    it("validates git_diff output shape", () => {
      const output = GitDiffOutputSchema.parse({
        diff: "diff --git a/file b/file\n+new line",
        filesChanged: 1,
        insertions: 1,
        deletions: 0,
        isTruncated: false,
      });
      expect(output.filesChanged).toBe(1);
      expect(output.insertions).toBe(1);
    });

    it("validates run_command output shape", () => {
      const output = RunCommandOutputSchema.parse({
        exitCode: 0,
        stdout: "PASS\n",
        stderr: "",
        durationMs: 450,
        outputTruncated: false,
        commandHash: "d".repeat(64),
      });
      expect(output.exitCode).toBe(0);
      expect(output.stdout).toBe("PASS\n");
    });
  });

  // =========================================================================
  // 10. Tool Request & Tool Result Model
  // =========================================================================
  describe("10. Tool Request & Tool Result Model", () => {
    it("constructs a typed ToolRequest without embedding authority or overrides", () => {
      const request: ToolRequest<"read_file"> = {
        requestId: "req-1",
        runId: "run-100",
        toolName: "read_file",
        input: {
          path: "src/app.ts",
          offsetLine: 1,
          limitLines: 100,
        },
      };
      expect(request.requestId).toBe("req-1");
      expect(request.runId).toBe("run-100");
      expect(request.toolName).toBe("read_file");
      expect(request.input.path).toBe("src/app.ts");
    });

    it("constructs a successful ToolResult envelope", () => {
      const result: ToolResult<"write_file"> = {
        requestId: "req-2",
        toolName: "write_file",
        status: "SUCCESS",
        output: {
          path: "src/generated.ts",
          bytesWritten: 250,
          created: true,
        },
        durationMs: 12,
      };
      expect(result.status).toBe("SUCCESS");
      expect(result.output?.bytesWritten).toBe(250);
      expect(result.error).toBeUndefined();
    });

    it("constructs a failed ToolResult envelope carrying structured error", () => {
      const err = new InvalidToolInputError("read_file", "Path does not exist", {
        path: "ghost.ts",
      });
      const result: ToolResult<"read_file"> = {
        requestId: "req-3",
        toolName: "read_file",
        status: "FAILED",
        error: err.toPayload(),
        durationMs: 5,
      };
      expect(result.status).toBe("FAILED");
      expect(result.output).toBeUndefined();
      expect(result.error?.code).toBe("INVALID_TOOL_INPUT");
      expect(result.error?.category).toBe("validation");
    });
  });

  // =========================================================================
  // 11. Error Taxonomy & Categorization
  // =========================================================================
  describe("11. Error Taxonomy & Categorization", () => {
    it("defines all nine stable tool error codes", () => {
      expect(TOOL_ERROR_CODES).toHaveLength(13);
      expect(TOOL_ERROR_CODES).toEqual([
        "TOOL_NOT_FOUND",
        "INVALID_TOOL_INPUT",
        "CAPABILITY_DENIED",
        "WORKSPACE_BOUNDARY_VIOLATION",
        "TOOL_TIMEOUT",
        "TOOL_OUTPUT_LIMIT_EXCEEDED",
        "TOOL_EXECUTION_FAILED",
        "TOOL_CANCELLED",
        "TOOL_PROVIDER_UNAVAILABLE",
        "WAITING_APPROVAL",
        "APPROVAL_REJECTED",
        "APPROVAL_EXPIRED",
        "APPROVAL_INVALID",
      ]);
    });

    it("maps every tool error code to its authoritative category", () => {
      expect(TOOL_ERROR_CATEGORY_MAP.TOOL_NOT_FOUND).toBe("provider");
      expect(TOOL_ERROR_CATEGORY_MAP.INVALID_TOOL_INPUT).toBe("validation");
      expect(TOOL_ERROR_CATEGORY_MAP.CAPABILITY_DENIED).toBe("authorization");
      expect(TOOL_ERROR_CATEGORY_MAP.WORKSPACE_BOUNDARY_VIOLATION).toBe("workspace");
      expect(TOOL_ERROR_CATEGORY_MAP.TOOL_TIMEOUT).toBe("resource");
      expect(TOOL_ERROR_CATEGORY_MAP.TOOL_OUTPUT_LIMIT_EXCEEDED).toBe("resource");
      expect(TOOL_ERROR_CATEGORY_MAP.TOOL_EXECUTION_FAILED).toBe("execution");
      expect(TOOL_ERROR_CATEGORY_MAP.TOOL_CANCELLED).toBe("cancellation");
      expect(TOOL_ERROR_CATEGORY_MAP.TOOL_PROVIDER_UNAVAILABLE).toBe("provider");
    });

    it("instantiates domain error classes and inherits from DomainError", () => {
      const errors: ToolDomainError[] = [
        new ToolNotFoundError("exec_tool"),
        new InvalidToolInputError("read_file", "path is empty"),
        new ToolCapabilityDeniedError("run_command", "process.execute", "denied by policy"),
        new ToolWorkspaceBoundaryViolationError("write_file", "/etc/passwd"),
        new ToolTimeoutError("run_command", 10000),
        new ToolOutputLimitExceededError("read_file", 100000, 150000),
        new ToolExecutionFailedError("run_command", "exit code 1"),
        new ToolCancelledError("search_code", "run timed out"),
        new ToolProviderUnavailableError("run_command", "docker daemon dead"),
      ];

      for (const err of errors) {
        expect(err).toBeInstanceOf(DomainError);
        expect(err).toBeInstanceOf(ToolDomainError);
        expect(typeof err.code).toBe("string");
        expect(typeof err.category).toBe("string");
        expect(err.message.length).toBeGreaterThan(0);

        const payload = err.toPayload();
        expect(payload.code).toBe(err.code);
        expect(payload.category).toBe(err.category);
        expect(payload.message).toBe(err.message);
      }
    });

    it("differentiates non-retryable authorization errors from retryable provider errors", () => {
      const authErr = new ToolCapabilityDeniedError("run_command", "process.execute");
      const providerErr = new ToolProviderUnavailableError("run_command", "Docker reconnecting");

      expect(authErr.category).toBe("authorization");
      expect(providerErr.category).toBe("provider");
      expect(authErr.category).not.toBe(providerErr.category);
    });
  });
});
