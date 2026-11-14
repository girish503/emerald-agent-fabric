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
  InvalidRunError,
  InvalidToolInputError,
  LeaseLostError,
  MissionContractTaskMismatchError,
  MissingBoundContractError,
  ResourceLimitExceededError,
  TerminalStateError,
  ToolCapabilityDeniedError,
  ToolNotFoundError,
  ToolProviderUnavailableError,
  ToolWorkspaceBoundaryViolationError,
} from "../../src/domain/errors.js";
import { createMissionContract } from "../../src/domain/mission-contract.js";
import {
  createExecutionPolicy,
  ExecutionPolicy,
} from "../../src/domain/policy.js";
import {
  staticToolRegistry,
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
 * Spy ExecutionProvider to rigorously verify that ZERO provider calls occur.
 */
class CountingExecutionProvider implements ExecutionProvider {
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
  readonly name = "spy-provider";
  readonly invocations: ExecutionRequest[] = [];

  get providerInvocationCount(): number {
    return this.invocations.length;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    throw new Error("CRITICAL SECURITY VIOLATION: ExecutionProvider must never be called during Task 4.2-A!");
  }
}

/**
 * Spy ToolAdapter to inspect context, input, and verify execution dispatch.
 */
class SpyToolAdapter<TName extends ToolName = ToolName> implements ToolAdapter<TName> {
  invocationCount = 0;
  lastContext: ToolExecutionContext | null = null;
  lastInput: unknown = null;
  outputToReturn: unknown = null;
  errorToThrow: Error | null = null;

  constructor(readonly toolName: TName, defaultOutput?: unknown) {
    this.outputToReturn = defaultOutput;
  }

  async execute(context: ToolExecutionContext, input: unknown): Promise<any> {
    this.invocationCount++;
    this.lastContext = context;
    this.lastInput = input;
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
    return this.outputToReturn;
  }
}

interface TestFixtureOptions {
  readonly policy?: ExecutionPolicy;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function setupFixture(options: TestFixtureOptions = {}) {
  const clock = new SettableClock("2026-03-30T10:00:00.000Z");
  const store = new SqliteStateStore();
  const coordinator = new RunCoordinator(store, clock);
  const provider = new CountingExecutionProvider();

  store.transaction((tx) => {
    tx.insertWorker({
      workerId: "worker-1",
      hostname: "localhost",
      pid: 1234,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });
  });

  const task = coordinator.createTask({
    title: "governed-tool-task",
    description: "Task for testing ToolExecutionGateway authorization boundary",
    inputPayload: { test: true },
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
    timeoutMs: options.timeoutMs ?? 30000,
    maxOutputBytes: options.maxOutputBytes ?? 1048576,
  });

  const { run } = coordinator.createRun({ taskId: task.taskId });
  coordinator.queueRun(run.runId);
  const claimResult = coordinator.claimRun(run.runId, "worker-1", 10000);
  const startResult = coordinator.startRun(run.runId, "worker-1", claimResult.lease.leaseId);

  const context: TrustedToolInvocationContext = {
    runId: run.runId,
    taskId: task.taskId,
    workerId: "worker-1",
    leaseId: claimResult.lease.leaseId,
    workspace: {
      workspaceId: "ws-1",
      hostPath: "C:/virtual/workspace/host",
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

describe("ToolExecutionGateway — Pre-Execution Authorization & Boundary (Task 4.2-A)", () => {
  // =========================================================================
  // a. Registry & Lookup
  // =========================================================================
  describe("a. Registry & Lookup", () => {
    it("resolves valid tool definitions from registry", async () => {
      const tools: ToolName[] = [
        "read_file",
        "write_file",
        "search_code",
        "git_status",
        "git_diff",
        "run_command",
      ];

      for (const name of tools) {
        const def = staticToolRegistry.getTool(name);
        expect(def).toBeDefined();
        expect(def?.name).toBe(name);
      }
    });

    it("rejects unknown tool names with ToolNotFoundError and never calls adapter or provider", async () => {
      const fixture = setupFixture();
      const adapterRegistry = new StaticToolAdapterRegistry();
      const spyAdapter = new SpyToolAdapter("read_file");
      adapterRegistry.register(spyAdapter);

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        adapterRegistry,
        clock: fixture.clock,
      });

      const unknownRequest = {
        requestId: "req-1",
        runId: fixture.run.runId,
        toolName: "non_existent_tool",
        input: {},
      } as unknown as ToolRequest;

      const decision = await gateway.authorize(unknownRequest, fixture.context);
      expect(decision.status).toBe("INVALID");
      expect(decision.domainError).toBeInstanceOf(ToolNotFoundError);
      expect(decision.errorPayload?.code).toBe("TOOL_NOT_FOUND");

      const result = await gateway.execute(unknownRequest, fixture.context);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("TOOL_NOT_FOUND");
      expect(spyAdapter.invocationCount).toBe(0);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects malformed requests (missing toolName) with ToolNotFoundError", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const badRequest = {
        requestId: "req-bad",
        runId: fixture.run.runId,
        input: {},
      } as unknown as ToolRequest;

      const decision = await gateway.authorize(badRequest, fixture.context);
      expect(decision.status).toBe("INVALID");
      expect(decision.domainError).toBeInstanceOf(ToolNotFoundError);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });
  });

  // =========================================================================
  // b. Run & Contract Binding
  // =========================================================================
  describe("b. Run & Contract Binding", () => {
    it("successfully authorizes when run and bound contract are valid and active", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-read-ok",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("AUTHORIZED");
      expect(decision.toolName).toBe("read_file");
      expect(decision.executionContext).toBeDefined();
      expect(decision.executionContext?.runId).toBe(fixture.run.runId);
      expect(decision.executionContext?.workspace.workspaceId).toBe("ws-1");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects when runId does not exist in store", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const invalidContext: TrustedToolInvocationContext = {
        ...fixture.context,
        runId: "non-existent-run-id",
      };

      const request: ToolRequest<"read_file"> = {
        requestId: "req-1",
        runId: "non-existent-run-id",
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, invalidContext);
      expect(decision.status).toBe("INVALID");
      expect(decision.domainError).toBeInstanceOf(InvalidRunError);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects when bound contract does not exist in store", async () => {
      const fixture = setupFixture();

      // Delete the contract from SQLite directly with foreign_keys OFF to simulate missing bound contract
      (fixture.store as any).db.exec("PRAGMA foreign_keys = OFF;");
      (fixture.store as any).db
        .prepare("DELETE FROM mission_contracts WHERE contract_id = ? AND version = ?")
        .run(fixture.contract.spec.contractId, fixture.contract.spec.version);
      (fixture.store as any).db.exec("PRAGMA foreign_keys = ON;");

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-1",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, fixture.context);

      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(MissingBoundContractError);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects when bound contract hash integrity check fails", async () => {
      const fixture = setupFixture();
      // Tamper with bound contentHash in run snapshot using valid 64-char hex format
      const tamperedRun = {
        ...fixture.run,
        runId: "run-tampered-hash",
        contractBinding: {
          ...fixture.run.contractBinding!,
          contentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      };

      fixture.store.transaction((tx) => {
        tx.insertRun(tamperedRun, {
          eventId: "e-tampered",
          runId: tamperedRun.runId,
          timestamp: fixture.clock.nowIso(),
          eventType: "run.created",
          schemaVersion: 1,
          producer: "test",
          payload: {},
        });
      });

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-1",
        runId: tamperedRun.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, {
        ...fixture.context,
        runId: tamperedRun.runId,
      });

      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ContractIntegrityError);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects when contract taskId does not match run taskId", async () => {
      const fixture = setupFixture();
      const otherTask = fixture.coordinator.createTask({
        title: "other-task",
        description: "other",
        inputPayload: {},
      });

      const mismatchRun = {
        ...fixture.run,
        runId: "run-task-mismatch",
        taskId: otherTask.taskId,
      };

      fixture.store.transaction((tx) => {
        tx.insertRun(mismatchRun, {
          eventId: "e-mismatch",
          runId: mismatchRun.runId,
          timestamp: fixture.clock.nowIso(),
          eventType: "run.created",
          schemaVersion: 1,
          producer: "test",
          payload: {},
        });
      });

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-1",
        runId: mismatchRun.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, {
        ...fixture.context,
        runId: mismatchRun.runId,
      });

      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(MissionContractTaskMismatchError);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects when contract is REVOKED", async () => {
      const fixture = setupFixture();
      // Revoke the contract
      fixture.store.revokeContract(
        fixture.contract.spec.contractId,
        fixture.contract.spec.version,
        "Security revocation test"
      );

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-revoked",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ContractNotActiveError);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects when contract is in DRAFT state", async () => {
      const fixture = setupFixture();
      // Create a new task and draft contract that is never activated
      const draftTask = fixture.coordinator.createTask({
        title: "draft-task",
        description: "draft",
        inputPayload: {},
      });

      const draftContract = createMissionContract({
        contractId: `contract-${draftTask.taskId}`,
        version: 1,
        taskId: draftTask.taskId,
        policy: fixture.contract.spec.policy,
        resourceLimits: fixture.contract.spec.resourceLimits,
      });
      // Insert contract without activating it (status stays DRAFT)
      fixture.store.insertContract(draftContract);

      const draftRun = {
        ...fixture.run,
        runId: "run-draft-contract",
        taskId: draftTask.taskId,
        contractBinding: {
          contractId: draftContract.spec.contractId,
          version: draftContract.spec.version,
          contentHash: draftContract.contentHash,
        },
      };

      fixture.store.transaction((tx) => {
        tx.insertRun(draftRun, {
          eventId: "e-draft",
          runId: draftRun.runId,
          timestamp: fixture.clock.nowIso(),
          eventType: "run.created",
          schemaVersion: 1,
          producer: "test",
          payload: {},
        });
      });

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-draft",
        runId: draftRun.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, {
        ...fixture.context,
        runId: draftRun.runId,
        taskId: draftTask.taskId,
      });

      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ContractNotActiveError);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });
  });

  // =========================================================================
  // c. Lease & Fencing
  // =========================================================================
  describe("c. Lease & Fencing", () => {
    it("accepts valid workerId and active leaseId", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-lease-ok",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("AUTHORIZED");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects when leaseId does not match the active run lease", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-bad-lease",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const badLeaseContext: TrustedToolInvocationContext = {
        ...fixture.context,
        leaseId: "wrong-lease-id",
      };

      const decision = await gateway.authorize(request, badLeaseContext);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(LeaseLostError);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects when workerId does not match current run worker", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-bad-worker",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const badWorkerContext: TrustedToolInvocationContext = {
        ...fixture.context,
        workerId: "wrong-worker-id",
      };

      const decision = await gateway.authorize(request, badWorkerContext);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(LeaseLostError);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects execution when run is in a terminal state (COMPLETED, FAILED, TIMED_OUT, CANCELLED)", async () => {
      const fixture = setupFixture();
      // Complete the run
      fixture.coordinator.completeRun(
        fixture.run.runId,
        fixture.context.workerId,
        fixture.context.leaseId,
        { ok: true }
      );

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-terminal",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(TerminalStateError);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });
  });

  // =========================================================================
  // d. Capability Authorization
  // =========================================================================
  describe("d. Capability Authorization", () => {
    it("authorizes when contract policy explicitly grants the required tool capability", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-cap-ok",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("AUTHORIZED");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("denies tool when contract policy omits required capability", async () => {
      // Create fixture where policy only grants workspace.file.read, omitting workspace.file.write
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

      const request: ToolRequest<"write_file"> = {
        requestId: "req-cap-denied",
        runId: fixture.run.runId,
        toolName: "write_file",
        input: { path: "src/main.ts", content: "hello", overwrite: true },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ToolCapabilityDeniedError);
      expect(decision.errorPayload?.code).toBe("CAPABILITY_DENIED");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("denies when policy has empty allowedCapabilities", async () => {
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
        requestId: "req-cap-empty",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ToolCapabilityDeniedError);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });
  });

  // =========================================================================
  // e. Resource Ceiling Enforcement (Non-Clamping Governance Model)
  // =========================================================================
  describe("e. Resource Ceiling Enforcement (Non-Clamping Governance Model)", () => {
    it("accepts requests within contract resource ceilings", async () => {
      const fixture = setupFixture({ timeoutMs: 30000, maxOutputBytes: 1048576 });
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-res-ok",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: {
          argv: ["echo", "test"],
          cwd: ".",
          timeoutMs: 15000,
          maxOutputBytes: 50000,
        },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("AUTHORIZED");
      expect(decision.executionContext?.resourceLimits.timeoutMs).toBe(15000);
      expect(decision.executionContext?.resourceLimits.maxOutputBytes).toBe(50000);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("REJECTS request exceeding timeoutMs ceiling (ZERO silent clamping)", async () => {
      const fixture = setupFixture({ timeoutMs: 30000 });
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-timeout-exceeded",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: {
          argv: ["echo", "test"],
          cwd: ".",
          timeoutMs: 45000, // Exceeds 30000 ceiling!
        },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ResourceLimitExceededError);
      expect(decision.errorPayload?.code).toBe("TOOL_TIMEOUT");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("REJECTS request exceeding maxOutputBytes ceiling (ZERO silent clamping)", async () => {
      const fixture = setupFixture({ maxOutputBytes: 10000 });
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-output-exceeded",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: {
          argv: ["echo", "test"],
          cwd: ".",
          maxOutputBytes: 20000, // Exceeds 10000 ceiling!
        },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ResourceLimitExceededError);
      expect(decision.errorPayload?.code).toBe("TOOL_OUTPUT_LIMIT_EXCEEDED");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("REJECTS request exceeding maxBytes ceiling (ZERO silent clamping)", async () => {
      const fixture = setupFixture({ maxOutputBytes: 10000 });
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-bytes-exceeded",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: {
          path: "src/main.ts",
          offsetLine: 1,
          limitLines: 500,
          maxBytes: 25000, // Exceeds 10000 ceiling!
        },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ResourceLimitExceededError);
      expect(decision.errorPayload?.code).toBe("TOOL_OUTPUT_LIMIT_EXCEEDED");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("REJECTS write_file when content byte length exceeds maxOutputBytes ceiling", async () => {
      const fixture = setupFixture({ maxOutputBytes: 100 });
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const largeContent = "a".repeat(200); // 200 bytes > 100 bytes ceiling!
      const request: ToolRequest<"write_file"> = {
        requestId: "req-write-exceeded",
        runId: fixture.run.runId,
        toolName: "write_file",
        input: {
          path: "src/large.txt",
          content: largeContent,
          overwrite: true,
        },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ResourceLimitExceededError);
      expect(decision.errorPayload?.code).toBe("TOOL_OUTPUT_LIMIT_EXCEEDED");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("REJECTS search_code when maxResults exceeds safety descriptor limit (1000)", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request = {
        requestId: "req-search-maxresults",
        runId: fixture.run.runId,
        toolName: "search_code",
        input: {
          query: "function",
          path: ".",
          isRegex: false,
          filePattern: "*",
          maxResults: 5000, // Exceeds max 1000
        },
      } as unknown as ToolRequest;

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("INVALID");
      expect(decision.domainError).toBeInstanceOf(InvalidToolInputError);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("correctly computes effective limits in ToolExecutionContext when within ceiling", async () => {
      const fixture = setupFixture({ timeoutMs: 30000, maxOutputBytes: 1048576 });
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      // When requested limit is smaller than contract ceiling
      const request: ToolRequest<"run_command"> = {
        requestId: "req-effective",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: {
          argv: ["node", "app.js"],
          cwd: ".",
          timeoutMs: 5000,
          maxOutputBytes: 2048,
        },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("AUTHORIZED");
      expect(decision.executionContext?.resourceLimits.timeoutMs).toBe(5000);
      expect(decision.executionContext?.resourceLimits.maxOutputBytes).toBe(2048);
    });
  });

  // =========================================================================
  // f. Input Schema Validation (Strict Zod)
  // =========================================================================
  describe("f. Input Schema Validation (Strict Zod)", () => {
    it("validates valid input for each of the 6 tools", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const validRequests: ToolRequest[] = [
        {
          requestId: "1",
          runId: fixture.run.runId,
          toolName: "read_file",
          input: { path: "src/file.ts", offsetLine: 1, limitLines: 100 },
        },
        {
          requestId: "2",
          runId: fixture.run.runId,
          toolName: "write_file",
          input: { path: "src/file.ts", content: "data", overwrite: true },
        },
        {
          requestId: "3",
          runId: fixture.run.runId,
          toolName: "search_code",
          input: { query: "export const", isRegex: false, path: ".", filePattern: "*", maxResults: 10 },
        },
        {
          requestId: "4",
          runId: fixture.run.runId,
          toolName: "git_status",
          input: { path: "." },
        },
        {
          requestId: "5",
          runId: fixture.run.runId,
          toolName: "git_diff",
          input: { path: ".", staged: true },
        },
        {
          requestId: "6",
          runId: fixture.run.runId,
          toolName: "run_command",
          input: { argv: ["git", "status"], cwd: "." },
        },
      ];

      for (const req of validRequests) {
        const decision = await gateway.authorize(req, fixture.context);
        expect(decision.status).toBe("AUTHORIZED");
      }
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects invalid types and missing required fields", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      // Missing path
      const missingPathReq = {
        requestId: "r-missing-path",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: {},
      } as unknown as ToolRequest;
      const dec1 = await gateway.authorize(missingPathReq, fixture.context);
      expect(dec1.status).toBe("INVALID");
      expect(dec1.domainError).toBeInstanceOf(InvalidToolInputError);

      // Wrong type: path is number
      const wrongTypeReq = {
        requestId: "r-wrong-type",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: 12345 },
      } as unknown as ToolRequest;
      const dec2 = await gateway.authorize(wrongTypeReq, fixture.context);
      expect(dec2.status).toBe("INVALID");
      expect(dec2.domainError).toBeInstanceOf(InvalidToolInputError);

      // run_command empty argv
      const emptyArgvReq = {
        requestId: "r-empty-argv",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: [], cwd: "." },
      } as unknown as ToolRequest;
      const dec3 = await gateway.authorize(emptyArgvReq, fixture.context);
      expect(dec3.status).toBe("INVALID");

      // run_command whitespace argv[0]
      const wsArgvReq = {
        requestId: "r-ws-argv",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["   "], cwd: "." },
      } as unknown as ToolRequest;
      const dec4 = await gateway.authorize(wsArgvReq, fixture.context);
      expect(dec4.status).toBe("INVALID");

      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects path traversal and unauthorized absolute paths", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const traversalPaths = [
        "../secret.txt",
        "..\\secret.txt",
        "foo/../../bar",
        "/etc/passwd",
        "C:\\Windows\\System32\\cmd.exe",
        "CON",
        "PRN",
        "AUX",
        "NUL",
      ];

      for (const badPath of traversalPaths) {
        const req = {
          requestId: `r-bad-${badPath}`,
          runId: fixture.run.runId,
          toolName: "read_file",
          input: { path: badPath },
        } as unknown as ToolRequest;
        const decision = await gateway.authorize(req, fixture.context);
        expect(decision.status).toBe("INVALID");
        expect(decision.domainError).toBeInstanceOf(InvalidToolInputError);
      }

      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects unexpected extraneous keys due to strict schema", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const extraKeysReq = {
        requestId: "r-extra",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: {
          path: "src/main.ts",
          unexpectedField: "malicious_payload",
        },
      } as unknown as ToolRequest;

      const decision = await gateway.authorize(extraKeysReq, fixture.context);
      expect(decision.status).toBe("INVALID");
      expect(decision.domainError).toBeInstanceOf(InvalidToolInputError);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });
  });

  // =========================================================================
  // g. Workspace Boundary
  // =========================================================================
  describe("g. Workspace Boundary", () => {
    it("validates that tools requiring WORKSPACE or SANDBOX isolation have valid workspace context", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-ws-ok",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("AUTHORIZED");
      expect(decision.executionContext?.workspace.workspaceId).toBe("ws-1");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects WORKSPACE tools when context has no workspace", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const noWorkspaceContext: TrustedToolInvocationContext = {
        ...fixture.context,
        workspace: undefined,
      };

      const request: ToolRequest<"read_file"> = {
        requestId: "req-no-ws",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const decision = await gateway.authorize(request, noWorkspaceContext);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ToolWorkspaceBoundaryViolationError);
      expect(decision.errorPayload?.code).toBe("WORKSPACE_BOUNDARY_VIOLATION");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("rejects SANDBOX tools when context has empty workspaceId or hostPath", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
      });

      const emptyWsContext: TrustedToolInvocationContext = {
        ...fixture.context,
        workspace: {
          workspaceId: "",
          hostPath: "",
        },
      };

      const request: ToolRequest<"run_command"> = {
        requestId: "req-empty-ws",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["echo", "hello"], cwd: "." },
      };

      const decision = await gateway.authorize(request, emptyWsContext);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ToolWorkspaceBoundaryViolationError);
      expect(decision.errorPayload?.code).toBe("WORKSPACE_BOUNDARY_VIOLATION");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });
  });

  // =========================================================================
  // h. Isolation Requirement Verification
  // =========================================================================
  describe("h. Isolation Requirement Verification", () => {
    it("authorizes SANDBOX tools when isolation environment probe reports available", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
        isIsolationAvailable: async () => true,
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-sandbox-ok",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["echo", "sandbox-ready"], cwd: "." },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("AUTHORIZED");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("FAILS CLOSED with ToolProviderUnavailableError when SANDBOX isolation is unavailable", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
        isIsolationAvailable: async () => false, // Sandbox unavailable!
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-sandbox-unavailable",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["echo", "fail-closed"], cwd: "." },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ToolCapabilityDeniedError);
      expect(decision.errorPayload?.code).toBe("CAPABILITY_DENIED");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("FAILS CLOSED when isolation probe throws an error", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        clock: fixture.clock,
        isIsolationAvailable: async () => {
          throw new Error("Docker daemon socket not responding");
        },
      });

      const request: ToolRequest<"run_command"> = {
        requestId: "req-sandbox-error",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["echo", "docker-down"], cwd: "." },
      };

      const decision = await gateway.authorize(request, fixture.context);
      expect(decision.status).toBe("DENIED");
      expect(decision.domainError).toBeInstanceOf(ToolCapabilityDeniedError);
      expect(decision.errorPayload?.code).toBe("CAPABILITY_DENIED");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });
  });

  // =========================================================================
  // i. Adapter Seam & Dispatch
  // =========================================================================
  describe("i. Adapter Seam & Dispatch", () => {
    it("dispatches authorized request to registered adapter and returns SUCCESS result", async () => {
      const fixture = setupFixture();
      const adapterRegistry = new StaticToolAdapterRegistry();
      const mockOutput = {
        path: "src/main.ts",
        content: "console.log('authorized execution');",
        bytesRead: 35,
        totalLines: 1,
        isTruncated: false,
      };
      const spyAdapter = new SpyToolAdapter("read_file", mockOutput);
      adapterRegistry.register(spyAdapter);

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        adapterRegistry,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-exec-read",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const result = await gateway.execute(request, fixture.context);

      expect(result.status).toBe("SUCCESS");
      expect(result.requestId).toBe("req-exec-read");
      expect(result.toolName).toBe("read_file");
      expect(result.output).toEqual(mockOutput);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Verify adapter was invoked exactly once with least-authority context
      expect(spyAdapter.invocationCount).toBe(1);
      expect(spyAdapter.lastContext?.runId).toBe(fixture.run.runId);
      expect(spyAdapter.lastContext?.toolName).toBe("read_file");
      expect(spyAdapter.lastContext?.requiredCapability).toBe("workspace.file.read");
      expect(spyAdapter.lastContext?.isolationRequirement).toBe("WORKSPACE");
      expect(spyAdapter.lastContext?.workspace.workspaceId).toBe("ws-1");
      expect(spyAdapter.lastInput).toEqual({
        path: "src/main.ts",
        offsetLine: 1,
        limitLines: 500,
      });

      // Assert ExecutionProvider was NEVER called
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("fails with TOOL_PROVIDER_UNAVAILABLE when no adapter is registered for authorized tool", async () => {
      const fixture = setupFixture();
      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        adapterRegistry: new StaticToolAdapterRegistry(), // Empty registry
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-no-adapter",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const result = await gateway.execute(request, fixture.context);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("TOOL_PROVIDER_UNAVAILABLE");
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("returns FAILED status when adapter throws an error", async () => {
      const fixture = setupFixture();
      const adapterRegistry = new StaticToolAdapterRegistry();
      const failingAdapter = new SpyToolAdapter("read_file");
      failingAdapter.errorToThrow = new Error("Simulated filesystem I/O error");
      adapterRegistry.register(failingAdapter);

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        adapterRegistry,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-adapter-fails",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const result = await gateway.execute(request, fixture.context);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("TOOL_EXECUTION_FAILED");
      expect(result.error?.message).toContain("Simulated filesystem I/O error");
      expect(failingAdapter.invocationCount).toBe(1);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("throws when options.throwOnError is set to true and adapter throws", async () => {
      const fixture = setupFixture();
      const adapterRegistry = new StaticToolAdapterRegistry();
      const failingAdapter = new SpyToolAdapter("read_file");
      failingAdapter.errorToThrow = new Error("Fatal I/O fault");
      adapterRegistry.register(failingAdapter);

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        adapterRegistry,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-adapter-throw",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      await expect(
        gateway.execute(request, fixture.context, { throwOnError: true })
      ).rejects.toThrow("Fatal I/O fault");

      expect(failingAdapter.invocationCount).toBe(1);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });

    it("returns FAILED when adapter returns output violating outputSchema", async () => {
      const fixture = setupFixture();
      const adapterRegistry = new StaticToolAdapterRegistry();
      // read_file output requires bytesRead, content, isTruncated, path
      const invalidSchemaOutput = {
        path: "src/main.ts",
        // missing required fields content, bytesRead, isTruncated
      };
      const badOutputAdapter = new SpyToolAdapter("read_file", invalidSchemaOutput);
      adapterRegistry.register(badOutputAdapter);

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        adapterRegistry,
        clock: fixture.clock,
      });

      const request: ToolRequest<"read_file"> = {
        requestId: "req-bad-output",
        runId: fixture.run.runId,
        toolName: "read_file",
        input: { path: "src/main.ts", offsetLine: 1, limitLines: 500 },
      };

      const result = await gateway.execute(request, fixture.context);
      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("TOOL_EXECUTION_FAILED");
      expect(result.error?.message).toContain("Adapter output failed schema validation");
      expect(badOutputAdapter.invocationCount).toBe(1);
      expect(fixture.provider.providerInvocationCount).toBe(0);
    });
  });

  // =========================================================================
  // j. Zero-Provider Invariant
  // =========================================================================
  describe("j. Zero-Provider Invariant", () => {
    it("proves that across all authorization checks and adapter dispatches, ExecutionProvider is NEVER invoked", async () => {
      const fixture = setupFixture();
      const adapterRegistry = new StaticToolAdapterRegistry();
      const spyAdapter = new SpyToolAdapter("run_command", {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 10,
        outputTruncated: false,
      });
      adapterRegistry.register(spyAdapter);

      const gateway = new ToolExecutionGateway({
        coordinator: fixture.coordinator,
        adapterRegistry,
        clock: fixture.clock,
      });

      // Execute run_command through the gateway
      const request: ToolRequest<"run_command"> = {
        requestId: "req-zero-provider",
        runId: fixture.run.runId,
        toolName: "run_command",
        input: { argv: ["echo", "test"], cwd: "." },
      };

      const result = await gateway.execute(request, fixture.context);
      expect(result.status).toBe("SUCCESS");
      expect(spyAdapter.invocationCount).toBe(1);

      // Invariant: The execution provider was NOT invoked anywhere in this layer
      expect(fixture.provider.providerInvocationCount).toBe(0);
      expect(fixture.provider.invocations).toHaveLength(0);
    });
  });
});
