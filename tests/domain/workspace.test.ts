import { describe, expect, it } from "vitest";
import {
  InvalidWorkspaceError,
  InvalidWorkspaceTransitionError,
  WorkspaceLeaseError,
} from "../../src/domain/errors.js";
import {
  applyWorkspaceTransition,
  isTerminalWorkspaceStatus,
  validateWorkspaceInvariants,
  Workspace,
  WorkspaceSnapshot,
} from "../../src/domain/workspace.js";

describe("Workspace Domain Aggregate & Lifecycle State Machine", () => {
  const now = "2026-10-11T12:00:00.000Z";
  let eventSeq = 0;
  const mockEventIdGen = () => `ws-evt-${++eventSeq}`;

  describe("Workspace Creation & Invariant Validation", () => {
    it("creates a new workspace in PROVISIONING state and emits workspace.provisioning", () => {
      const { workspace, event } = Workspace.create({
        workspaceId: "ws-1001",
        runId: "run-2001",
        taskId: "task-3001",
        repositorySource: {
          type: "git",
          location: "https://github.com/org/repo.git",
          revision: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        },
        maxWorkspaceBytes: 1024 * 1024 * 500, // 500 MB
        maxFileSizeBytes: 1024 * 1024 * 10,   // 10 MB
        now,
        eventIdGenerator: mockEventIdGen,
      });

      expect(workspace.workspaceId).toBe("ws-1001");
      expect(workspace.runId).toBe("run-2001");
      expect(workspace.taskId).toBe("task-3001");
      expect(workspace.status).toBe("PROVISIONING");
      expect(workspace.assignedWorkerId).toBeNull();
      expect(workspace.leaseId).toBeNull();
      expect(workspace.leasedAt).toBeNull();
      expect(workspace.errorMessage).toBeNull();
      expect(workspace.createdAt).toBe(now);
      expect(workspace.updatedAt).toBe(now);
      expect(Object.isFrozen(workspace.snapshot)).toBe(true);
      expect(Object.isFrozen(workspace.spec)).toBe(true);

      expect(event.eventType).toBe("workspace.provisioning");
      expect(event.runId).toBe("run-2001");
      expect(event.payload.workspaceId).toBe("ws-1001");
      expect(event.payload.taskId).toBe("task-3001");
      expect(event.payload.repositorySource?.type).toBe("git");
      expect(event.payload.repositorySource?.revision).toBe("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    });

    it("uses sensible provider defaults if limits are omitted", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-1002",
        runId: "run-2002",
        taskId: "task-3002",
        now,
      });

      expect(workspace.spec.maxWorkspaceBytes).toBe(500 * 1024 * 1024);
      expect(workspace.spec.maxFileSizeBytes).toBe(10 * 1024 * 1024);
    });

    it("rejects creation with empty workspaceId", () => {
      expect(() => {
        Workspace.create({
          workspaceId: "",
          runId: "run-001",
          taskId: "task-001",
        });
      }).toThrowError(InvalidWorkspaceError);
    });

    it("rejects creation with empty runId", () => {
      expect(() => {
        Workspace.create({
          workspaceId: "ws-001",
          runId: "  ",
          taskId: "task-001",
        });
      }).toThrowError(InvalidWorkspaceError);
    });

    it("rejects creation with empty taskId", () => {
      expect(() => {
        Workspace.create({
          workspaceId: "ws-001",
          runId: "run-001",
          taskId: "",
        });
      }).toThrowError(InvalidWorkspaceError);
    });

    it("rejects non-positive resource limits", () => {
      expect(() => {
        Workspace.create({
          workspaceId: "ws-001",
          runId: "run-001",
          taskId: "task-001",
          maxWorkspaceBytes: 0,
        });
      }).toThrowError(InvalidWorkspaceError);

      expect(() => {
        Workspace.create({
          workspaceId: "ws-001",
          runId: "run-001",
          taskId: "task-001",
          maxFileSizeBytes: -1,
        });
      }).toThrowError(InvalidWorkspaceError);
    });

    it("rejects invalid repository source types", () => {
      expect(() => {
        Workspace.create({
          workspaceId: "ws-001",
          runId: "run-001",
          taskId: "task-001",
          // @ts-expect-error Testing invalid runtime enum
          repositorySource: { type: "ftp", location: "loc", revision: "rev" },
        });
      }).toThrowError(InvalidWorkspaceError);
    });
  });

  describe("End-to-End Lifecycle State Machine", () => {
    it("executes valid happy-path lifecycle: PROVISIONING -> READY -> LEASED -> CLEANING -> DISPOSED", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-lifecycle-1",
        runId: "run-lifecycle-1",
        taskId: "task-lifecycle-1",
        now,
        eventIdGenerator: mockEventIdGen,
      });

      expect(workspace.status).toBe("PROVISIONING");

      // 1. Mark Ready
      const readyTime = "2026-10-11T12:01:00.000Z";
      const readyEvent = workspace.markReady({
        now: readyTime,
        hostPath: "/workspaces/ws-lifecycle-1",
        containerMountPath: "/workspace",
      });
      expect(workspace.status).toBe("READY");
      expect(workspace.updatedAt).toBe(readyTime);
      expect(readyEvent.eventType).toBe("workspace.ready");
      expect(readyEvent.payload.hostPath).toBe("/workspaces/ws-lifecycle-1");
      expect(readyEvent.payload.containerMountPath).toBe("/workspace");

      // 2. Claim Lease
      const leaseTime = "2026-10-11T12:02:00.000Z";
      const leasedEvent = workspace.claimLease({
        workerId: "worker-alpha",
        leaseId: "lease-999",
        now: leaseTime,
      });
      expect(workspace.status).toBe("LEASED");
      expect(workspace.assignedWorkerId).toBe("worker-alpha");
      expect(workspace.leaseId).toBe("lease-999");
      expect(workspace.leasedAt).toBe(leaseTime);
      expect(leasedEvent.eventType).toBe("workspace.leased");
      expect(leasedEvent.payload.workerId).toBe("worker-alpha");
      expect(leasedEvent.payload.leaseId).toBe("lease-999");

      // 3. Start Cleaning
      const cleanTime = "2026-10-11T12:03:00.000Z";
      const cleaningEvent = workspace.startCleaning({
        reason: "Run completed successfully",
        workerId: "worker-alpha",
        leaseId: "lease-999",
        now: cleanTime,
      });
      expect(workspace.status).toBe("CLEANING");
      expect(workspace.assignedWorkerId).toBeNull();
      expect(workspace.leaseId).toBeNull();
      expect(workspace.leasedAt).toBeNull();
      expect(cleaningEvent.eventType).toBe("workspace.cleaning");
      expect(cleaningEvent.payload.reason).toBe("Run completed successfully");

      // 4. Mark Disposed
      const disposeTime = "2026-10-11T12:04:00.000Z";
      const disposedEvent = workspace.markDisposed({ now: disposeTime });
      expect(workspace.status).toBe("DISPOSED");
      expect(disposedEvent.eventType).toBe("workspace.disposed");
      expect(isTerminalWorkspaceStatus(workspace.status)).toBe(true);
    });

    it("supports early teardown from READY before leasing", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-abort",
        runId: "run-abort",
        taskId: "task-abort",
        now,
      });

      workspace.markReady({ now });
      expect(workspace.status).toBe("READY");

      workspace.startCleaning({ reason: "Run cancelled prior to start", now });
      expect(workspace.status).toBe("CLEANING");

      workspace.markDisposed({ now });
      expect(workspace.status).toBe("DISPOSED");
    });
  });

  describe("Failure State Transitions", () => {
    it("transitions to FAILED from PROVISIONING on acquisition failure", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-fail-1",
        runId: "run-fail-1",
        taskId: "task-fail-1",
        now,
      });

      const failEvent = workspace.markFailed({
        errorMessage: "Git clone timed out after 30000ms",
        now,
      });

      expect(workspace.status).toBe("FAILED");
      expect(workspace.errorMessage).toBe("Git clone timed out after 30000ms");
      expect(failEvent.eventType).toBe("workspace.failed");
      expect(failEvent.payload.fromState).toBe("PROVISIONING");
      expect(failEvent.payload.errorMessage).toBe("Git clone timed out after 30000ms");
      expect(isTerminalWorkspaceStatus(workspace.status)).toBe(true);
    });

    it("transitions to FAILED from READY", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-fail-2",
        runId: "run-fail-2",
        taskId: "task-fail-2",
        now,
      });

      workspace.markReady({ now });
      workspace.markFailed({ errorMessage: "Host disk quota exceeded", now });
      expect(workspace.status).toBe("FAILED");
    });

    it("transitions to FAILED from LEASED on runtime failure", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-fail-3",
        runId: "run-fail-3",
        taskId: "task-fail-3",
        now,
      });

      workspace.markReady({ now });
      workspace.claimLease({ workerId: "w1", leaseId: "l1", now });
      workspace.markFailed({ errorMessage: "Container I/O crashed", now });
      expect(workspace.status).toBe("FAILED");
    });

    it("transitions to FAILED from CLEANING on unmount/rm failure", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-fail-4",
        runId: "run-fail-4",
        taskId: "task-fail-4",
        now,
      });

      workspace.markReady({ now });
      workspace.claimLease({ workerId: "w1", leaseId: "l1", now });
      workspace.startCleaning({ workerId: "w1", leaseId: "l1", now });
      workspace.markFailed({ errorMessage: "EBUSY: resource busy or locked", now });
      expect(workspace.status).toBe("FAILED");
    });
  });

  describe("Invalid State Transitions Rejection", () => {
    it("rejects claiming a lease directly from PROVISIONING", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-inv-1",
        runId: "run-inv-1",
        taskId: "task-inv-1",
        now,
      });

      expect(() => {
        workspace.claimLease({ workerId: "w1", leaseId: "l1", now });
      }).toThrowError(InvalidWorkspaceTransitionError);
    });

    it("rejects markReady when already in READY or LEASED", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-inv-2",
        runId: "run-inv-2",
        taskId: "task-inv-2",
        now,
      });

      workspace.markReady({ now });
      expect(() => {
        workspace.markReady({ now });
      }).toThrowError(InvalidWorkspaceTransitionError);
    });

    it("rejects markDisposed from LEASED state without CLEANING", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-inv-3",
        runId: "run-inv-3",
        taskId: "task-inv-3",
        now,
      });

      workspace.markReady({ now });
      workspace.claimLease({ workerId: "w1", leaseId: "l1", now });
      expect(() => {
        workspace.markDisposed({ now });
      }).toThrowError(InvalidWorkspaceTransitionError);
    });

    it("rejects mutations when in terminal DISPOSED state", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-term-1",
        runId: "run-term-1",
        taskId: "task-term-1",
        now,
      });

      workspace.markReady({ now });
      workspace.startCleaning({ now });
      workspace.markDisposed({ now });

      expect(() => {
        workspace.markReady({ now });
      }).toThrowError(InvalidWorkspaceTransitionError);

      expect(() => {
        workspace.claimLease({ workerId: "w1", leaseId: "l1", now });
      }).toThrowError(InvalidWorkspaceTransitionError);

      expect(() => {
        workspace.markFailed({ errorMessage: "Late failure", now });
      }).toThrowError(InvalidWorkspaceTransitionError);
    });

    it("rejects mutations when in terminal FAILED state", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-term-2",
        runId: "run-term-2",
        taskId: "task-term-2",
        now,
      });

      workspace.markFailed({ errorMessage: "Fatal crash", now });

      expect(() => {
        workspace.markReady({ now });
      }).toThrowError(InvalidWorkspaceTransitionError);

      expect(() => {
        workspace.markDisposed({ now });
      }).toThrowError(InvalidWorkspaceTransitionError);
    });
  });

  describe("Worker Lease Fencing Token Validation", () => {
    it("rejects cleaning from LEASED if workerId does not match", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-fence-1",
        runId: "run-fence-1",
        taskId: "task-fence-1",
        now,
      });

      workspace.markReady({ now });
      workspace.claimLease({ workerId: "worker-authorized", leaseId: "lease-token-1", now });

      expect(() => {
        workspace.startCleaning({
          workerId: "worker-impostor",
          leaseId: "lease-token-1",
          now,
        });
      }).toThrowError(WorkspaceLeaseError);
    });

    it("rejects cleaning from LEASED if leaseId does not match", () => {
      const { workspace } = Workspace.create({
        workspaceId: "ws-fence-2",
        runId: "run-fence-2",
        taskId: "task-fence-2",
        now,
      });

      workspace.markReady({ now });
      workspace.claimLease({ workerId: "worker-authorized", leaseId: "lease-token-1", now });

      expect(() => {
        workspace.startCleaning({
          workerId: "worker-authorized",
          leaseId: "stale-lease-token",
          now,
        });
      }).toThrowError(WorkspaceLeaseError);
    });
  });

  describe("Reconstitution from Snapshot", () => {
    it("reconstitutes an existing workspace and allows valid subsequent transitions", () => {
      const originalSnapshot: WorkspaceSnapshot = {
        workspaceId: "ws-reconst",
        runId: "run-reconst",
        taskId: "task-reconst",
        status: "READY",
        spec: {
          workspaceId: "ws-reconst",
          runId: "run-reconst",
          taskId: "task-reconst",
          maxWorkspaceBytes: 100 * 1024 * 1024,
          maxFileSizeBytes: 5 * 1024 * 1024,
        },
        assignedWorkerId: null,
        leaseId: null,
        leasedAt: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };

      const workspace = Workspace.reconstitute(originalSnapshot);
      expect(workspace.workspaceId).toBe("ws-reconst");
      expect(workspace.status).toBe("READY");

      workspace.claimLease({ workerId: "worker-b", leaseId: "lease-b", now });
      expect(workspace.status).toBe("LEASED");
      expect(workspace.assignedWorkerId).toBe("worker-b");
    });
  });

  describe("Pure Transition & Invariant Validator Functions", () => {
    it("validates snapshot invariants directly", () => {
      const validSnapshot: WorkspaceSnapshot = {
        workspaceId: "ws-valid",
        runId: "run-valid",
        taskId: "task-valid",
        status: "PROVISIONING",
        spec: {
          workspaceId: "ws-valid",
          runId: "run-valid",
          taskId: "task-valid",
          maxWorkspaceBytes: 1000,
          maxFileSizeBytes: 100,
        },
        assignedWorkerId: null,
        leaseId: null,
        leasedAt: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };

      expect(() => validateWorkspaceInvariants(validSnapshot)).not.toThrow();

      const invalidSnapshot: WorkspaceSnapshot = {
        ...validSnapshot,
        status: "LEASED", // LEASED requires assignedWorkerId and leaseId
      };
      expect(() => validateWorkspaceInvariants(invalidSnapshot)).toThrowError(
        InvalidWorkspaceError
      );
    });

    it("applies pure workspace transitions directly via applyWorkspaceTransition", () => {
      const initialSnapshot: WorkspaceSnapshot = {
        workspaceId: "ws-pure-1",
        runId: "run-pure-1",
        taskId: "task-pure-1",
        status: "PROVISIONING",
        spec: {
          workspaceId: "ws-pure-1",
          runId: "run-pure-1",
          taskId: "task-pure-1",
          maxWorkspaceBytes: 1000,
          maxFileSizeBytes: 100,
        },
        assignedWorkerId: null,
        leaseId: null,
        leasedAt: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };

      const result = applyWorkspaceTransition(
        initialSnapshot,
        { type: "MARK_READY", now },
        mockEventIdGen
      );

      expect(result.nextSnapshot.status).toBe("READY");
      expect(result.event.eventType).toBe("workspace.ready");
      expect(result.event.payload.workspaceId).toBe("ws-pure-1");
    });
  });
});

