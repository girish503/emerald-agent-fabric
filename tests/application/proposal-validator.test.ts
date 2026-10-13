import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import {
  ActionProposal,
  MAX_PROPOSAL_BYTES,
  MAX_RATIONALE_LENGTH,
} from "../../src/domain/action-proposal.js";
import { ContextSnapshot } from "../../src/domain/context.js";
import { ActionProposalRejectedError } from "../../src/domain/errors.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "./test-helpers.js";

describe("ProposalValidator Application Service", () => {
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let validator: ProposalValidator;
  const workerId = "worker-1";
  const validContextHash = "b".repeat(64);

  function createMockContextSnapshot(runId: string, taskId: string, contextHash: string = validContextHash): ContextSnapshot {
    return {
      snapshotId: "snap-1",
      runId,
      taskId,
      policyVersion: "v1",
      createdAt: clock.nowIso(),
      budget: {
        maxObservations: 50,
        maxEstimatedTokens: 4000,
        maxBytes: 16000,
        maxHistoryEvents: 20,
        maxActionHistory: 10,
        maxAttemptHistory: 10,
        maxToolOutputBytes: 2048,
        maxEvidenceItems: 10,
      },
      observations: [],
      omittedObservationsCount: 0,
      omittedObservationsSummary: [],
      totalEstimatedTokens: 100,
      totalBytes: 500,
      contextHash,
    };
  }

  beforeEach(() => {
    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-10-13T12:00:00Z"));
    coordinator = new RunCoordinator(store, clock);
    validator = new ProposalValidator({
      coordinator,
      stateStore: store,
      clock,
    });

    // Register worker in store
    store.transaction((tx) => {
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: 1234,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });
  });

  function setupActiveRun(options?: {
    allowedCapabilities?: string[];
    timeoutMs?: number;
    maxOutputBytes?: number;
    maxAttempts?: number;
  }) {
    const task = coordinator.createTask({
      title: "Validation Test Task",
      description: "Testing proposal validation",
      inputPayload: {},
    });

    const contract = createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: options?.allowedCapabilities ?? [
          "workspace.file.read",
          "workspace.file.write",
          "workspace.code.search",
          "process.execute",
        ],
        isolationRequirement: "ISOLATED",
      }),
      timeoutMs: options?.timeoutMs ?? 30000,
      maxOutputBytes: options?.maxOutputBytes ?? 1048576,
      maxAttempts: options?.maxAttempts ?? 3,
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claimResult = coordinator.claimRun(run.runId, workerId, 15000);
    coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

    const activeRunSnapshot = coordinator.getRun(run.runId)!;
    const contextSnapshot = createMockContextSnapshot(run.runId, task.taskId);

    return {
      task,
      contract,
      runSnapshot: activeRunSnapshot,
      leaseId: claimResult.lease.leaseId,
      contextSnapshot,
    };
  }

  describe("Stage 1: Payload Size Ceilings", () => {
    it("rejects oversized proposal exceeding MAX_PROPOSAL_BYTES", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const oversizedPayload = {
        proposalId: "prop-huge",
        toolName: "read_file",
        inputPayload: {
          path: "src/file.txt",
          extra: "x".repeat(MAX_PROPOSAL_BYTES + 100),
        },
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      const result = validator.validate(oversizedPayload, {
        runId: runSnapshot.runId,
        contextSnapshot,
        run: runSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("PROPOSAL_SIZE_EXCEEDED");
      }
    });
  });

  describe("Stage 2: Structural Verification & Forbidden Authority Fields", () => {
    it("rejects non-object proposal", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const result = validator.validate("not-an-object", {
        runId: runSnapshot.runId,
        contextSnapshot,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("MALFORMED_PROPOSAL");
      }
    });

    it("rejects proposal attempting to inject workerId or leaseId", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const malicious = {
        proposalId: "prop-1",
        toolName: "read_file",
        inputPayload: { path: "src/file.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
        workerId: "rogue-worker",
        leaseId: "stolen-lease",
      };

      const result = validator.validate(malicious, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("FORBIDDEN_AUTHORITY_FIELD");
        expect(result.violations).toContain("workerId");
        expect(result.violations).toContain("leaseId");
      }
    });

    it("rejects proposal attempting to inject contractId or capabilities", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const malicious = {
        proposalId: "prop-1",
        toolName: "read_file",
        inputPayload: { path: "src/file.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
        contractId: "bypass-contract",
        capability: "root.all",
      };

      const result = validator.validate(malicious, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("FORBIDDEN_AUTHORITY_FIELD");
        expect(result.violations).toContain("contractId");
        expect(result.violations).toContain("capability");
      }
    });

    it("rejects proposal attempting to specify execution status or results", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const malicious = {
        proposalId: "prop-1",
        toolName: "read_file",
        inputPayload: { path: "src/file.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
        status: "SUCCEEDED",
        resultPayload: { fabricated: true },
      };

      const result = validator.validate(malicious, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("FORBIDDEN_AUTHORITY_FIELD");
      }
    });

    it("rejects proposal with unrecognized top-level properties", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const malicious = {
        proposalId: "prop-1",
        toolName: "read_file",
        inputPayload: { path: "src/file.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
        customInjectedField: "value",
      };

      const result = validator.validate(malicious, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("FORBIDDEN_AUTHORITY_FIELD");
        expect(result.violations).toContain("customInjectedField");
      }
    });
  });

  describe("Stage 3: Schema Conformance & Bounds Validation", () => {
    it("rejects proposal with rationale exceeding MAX_RATIONALE_LENGTH", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const proposal = {
        proposalId: "prop-1",
        toolName: "read_file",
        inputPayload: { path: "src/file.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
        rationale: "r".repeat(MAX_RATIONALE_LENGTH + 1),
      };

      const result = validator.validate(proposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("RATIONALE_TOO_LONG");
      }
    });

    it("rejects malformed proposal missing required fields", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const proposal = {
        proposalId: "prop-1",
        // missing toolName
        inputPayload: { path: "src/file.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      const result = validator.validate(proposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("MALFORMED_PROPOSAL");
      }
    });
  });

  describe("Stage 4: Context Snapshot Hash Matching", () => {
    it("rejects proposal referencing mismatching contextSnapshotHash", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const proposal: ActionProposal = {
        proposalId: "prop-1",
        toolName: "read_file",
        inputPayload: { path: "src/file.txt" },
        contextSnapshotHash: "c".repeat(64), // Stale hash
      };

      const result = validator.validate(proposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("CONTEXT_HASH_MISMATCH");
      }
    });
  });

  describe("Stage 5: Authoritative Run & Lease Fencing", () => {
    it("rejects proposal for non-existent run", () => {
      const dummyContextSnapshot = createMockContextSnapshot("non-existent-run", "task-x");
      const proposal: ActionProposal = {
        proposalId: "prop-1",
        toolName: "read_file",
        inputPayload: { path: "src/file.txt" },
        contextSnapshotHash: dummyContextSnapshot.contextHash,
      };

      const result = validator.validate(proposal, {
        runId: "non-existent-run",
        contextSnapshot: dummyContextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("RUN_NOT_ACTIVE");
      }
    });

    it("rejects proposal for terminal run", () => {
      const { runSnapshot, leaseId, contextSnapshot } = setupActiveRun();
      coordinator.completeRun(runSnapshot.runId, workerId, leaseId, { ok: true });

      const proposal: ActionProposal = {
        proposalId: "prop-1",
        toolName: "read_file",
        inputPayload: { path: "src/file.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      const result = validator.validate(proposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("RUN_NOT_ACTIVE");
      }
    });

    it("rejects proposal when lease does not match", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const proposal: ActionProposal = {
        proposalId: "prop-1",
        toolName: "read_file",
        inputPayload: { path: "src/file.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      const result = validator.validate(proposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
        leaseId: "wrong-lease-id",
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("LEASE_INVALID");
      }
    });

    it("rejects proposal when workerId does not match", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const proposal: ActionProposal = {
        proposalId: "prop-1",
        toolName: "read_file",
        inputPayload: { path: "src/file.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      const result = validator.validate(proposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
        workerId: "wrong-worker-id",
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("LEASE_INVALID");
      }
    });
  });

  describe("Stage 6: Authoritative Mission Contract Integrity", () => {
    it("rejects proposal when bound contract is revoked", () => {
      const { runSnapshot, contract, contextSnapshot } = setupActiveRun();
      store.revokeContract(contract.spec.contractId, contract.spec.version, "Policy violation");

      const proposal: ActionProposal = {
        proposalId: "prop-1",
        toolName: "read_file",
        inputPayload: { path: "src/file.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      const result = validator.validate(proposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("CONTRACT_REVOKED");
      }
    });

    it("rejects proposal when bound contract hash does not match stored contract", () => {
      const { runSnapshot, contract, contextSnapshot } = setupActiveRun();

      // Corrupted contract with modified contentHash
      const corruptedContract = {
        ...contract,
        contentHash: "corrupted_hash_" + "0".repeat(49),
      };

      const proposal: ActionProposal = {
        proposalId: "prop-1",
        toolName: "read_file",
        inputPayload: { path: "src/file.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      const result = validator.validate(proposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
        run: runSnapshot,
        contract: corruptedContract as any,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("CONTRACT_REVOKED");
      }
    });
  });

  describe("Stage 7: Tool Registry Resolution", () => {
    it("rejects proposal for unknown or unregistered tool", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const proposal = {
        proposalId: "prop-1",
        toolName: "unknown_custom_tool",
        inputPayload: {},
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      const result = validator.validate(proposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      expect(["MALFORMED_PROPOSAL", "UNKNOWN_TOOL"]).toContain((result as any).reason);
    });
  });

  describe("Stage 8: Capability Authorization & Policy Evaluation", () => {
    it("rejects proposal when tool capability is not granted by policy", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun({
        allowedCapabilities: ["workspace.file.read"],
      });

      const proposal: ActionProposal = {
        proposalId: "prop-1",
        toolName: "run_command",
        inputPayload: { argv: ["echo", "hello"] },
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      const result = validator.validate(proposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("UNAUTHORIZED_CAPABILITY");
      }
    });
  });

  describe("Stage 9: Tool Input Schema & Path Traversal Protection", () => {
    it("rejects proposal missing required tool input parameters", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const proposal: ActionProposal = {
        proposalId: "prop-1",
        toolName: "read_file",
        inputPayload: {}, // Missing required 'path'
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      const result = validator.validate(proposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("INVALID_TOOL_INPUT");
        expect(result.violations?.length).toBeGreaterThan(0);
      }
    });

    it("rejects path traversal in tool input payload", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const traversalAttacks = [
        "../secret.txt",
        "../../etc/passwd",
        "/etc/shadow",
        "C:\\Windows\\system32",
        "subdir/../../escape.txt",
      ];

      for (const maliciousPath of traversalAttacks) {
        const proposal: ActionProposal = {
          proposalId: `prop-traversal-${maliciousPath}`,
          toolName: "read_file",
          inputPayload: { path: maliciousPath },
          contextSnapshotHash: contextSnapshot.contextHash,
        };

        const result = validator.validate(proposal, {
          runId: runSnapshot.runId,
          contextSnapshot,
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe("INVALID_TOOL_INPUT");
        }
      }
    });
  });

  describe("Stage 10: Resource Ceiling Checks", () => {
    it("rejects requested timeout exceeding contract ceiling", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun({ timeoutMs: 15000 });

      const proposal: ActionProposal = {
        proposalId: "prop-1",
        toolName: "run_command",
        inputPayload: {
          argv: ["sleep", "1"],
          timeoutMs: 20000, // Exceeds contract ceiling 15000
        },
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      const result = validator.validate(proposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("RESOURCE_LIMIT_EXCEEDED");
      }
    });

    it("rejects requested maxBytes exceeding contract ceiling", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun({ maxOutputBytes: 10000 });

      const proposal: ActionProposal = {
        proposalId: "prop-1",
        toolName: "write_file",
        inputPayload: {
          path: "out.txt",
          content: "hello",
          maxBytes: 20000, // Exceeds contract ceiling 10000
        },
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      const result = validator.validate(proposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("RESOURCE_LIMIT_EXCEEDED");
      }
    });
  });

  describe("Stage 11: Valid Proposal Acceptance & Action Instantiation", () => {
    it("validates a compliant proposal and returns ProposalValidationSuccess", () => {
      const { runSnapshot, contract, leaseId, contextSnapshot } = setupActiveRun();

      const validProposal: ActionProposal = {
        proposalId: "prop-compliant-1",
        toolName: "read_file",
        inputPayload: { path: "src/main.ts" },
        contextSnapshotHash: contextSnapshot.contextHash,
        rationale: "Reading entrypoint",
        sequenceHint: 1,
      };

      const result = validator.validate(validProposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
        workerId,
        leaseId,
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.proposal.proposalId).toBe("prop-compliant-1");
        expect(result.proposal.toolName).toBe("read_file");
        expect(result.proposal.contextSnapshotHash).toBe(contextSnapshot.contextHash);
        expect(result.proposal.rationale).toBe("Reading entrypoint");
        expect(result.requiredCapability).toBe("workspace.file.read");
        expect(result.contractBinding.contractId).toBe(contract.spec.contractId);
        expect(result.maxAttempts).toBe(contract.spec.resourceLimits.maxAttempts);
        expect(Object.isFrozen(result.proposal)).toBe(true);
      }
    });

    it("validateOrThrow throws ActionProposalRejectedError on invalid proposal", () => {
      const { runSnapshot, contextSnapshot } = setupActiveRun();
      const invalidProposal: ActionProposal = {
        proposalId: "prop-err",
        toolName: "read_file",
        inputPayload: { path: "../escape.txt" },
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      expect(() =>
        validator.validateOrThrow(invalidProposal, {
          runId: runSnapshot.runId,
          contextSnapshot,
        })
      ).toThrow(ActionProposalRejectedError);
    });

    it("transforms a validated proposal into an authoritative domain Action aggregate", () => {
      const { runSnapshot, leaseId, contextSnapshot } = setupActiveRun();

      const validProposal: ActionProposal = {
        proposalId: "prop-to-action-1",
        toolName: "read_file",
        inputPayload: { path: "src/main.ts" },
        contextSnapshotHash: contextSnapshot.contextHash,
      };

      const validation = validator.validateOrThrow(validProposal, {
        runId: runSnapshot.runId,
        contextSnapshot,
        workerId,
        leaseId,
      });

      const { action, event } = validator.createActionFromProposal(validation, runSnapshot);

      expect(action).toBeDefined();
      expect(action.actionId).toBeDefined();
      expect(action.runId).toBe(runSnapshot.runId);
      expect(action.sequenceNumber).toBe(1);
      expect(action.toolName).toBe("read_file");
      expect(action.status).toBe("CREATED");
      expect(action.maxAttempts).toBe(3); // Established authoritatively from contract, not proposal!
      expect(action.contractBinding).toEqual(runSnapshot.contractBinding);

      expect(event.eventType).toBe("action.created");
      expect(event.payload.runId).toBe(runSnapshot.runId);
      expect(event.payload.toolName).toBe("read_file");
    });
  });
});
