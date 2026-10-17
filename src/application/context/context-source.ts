import {
  Observation,
  ObservationFreshness,
  computeObservationContentHash,
  estimateBytes,
  estimateTokens,
  validateObservation,
} from "../../domain/context.js";
import { isTerminalState } from "../../domain/invariants.js";
import { redactSensitiveData } from "../../domain/canonical-hash.js";
import { StateStorePort } from "../../ports/state-store.port.js";
import { ContextSourcePort } from "../../ports/context-source.port.js";

/**
 * ContextSource gathers candidate observations from durable StateStorePort.
 * Strictly read-only: does not mutate runtime state or append domain events.
 */
export class ContextSource implements ContextSourcePort {
  constructor(private readonly stateStore: StateStorePort) {}

  /**
   * Reads durable state for a run and returns typed candidate observations.
   */
  async gatherCandidateObservations(runId: string): Promise<readonly Observation[]> {
    const run = this.stateStore.getRun(runId);
    if (!run) {
      throw new Error(`Run '${runId}' not found in state store`);
    }

    const observations: Observation[] = [];

    // 1. RUN_STATE (Mandatory safety observation)
    const runStateContent = redactSensitiveData({
      runId: run.runId,
      taskId: run.taskId,
      status: run.status,
      version: run.version,
      leaseId: run.leaseId,
      workerId: run.currentWorkerId,
      attemptCount: run.attemptCount,
      maxAttempts: run.maxAttempts,
      failureReason: run.errorPayload,
      isTerminal: isTerminalState(run.status),
    }) as Record<string, unknown>;

    const runStateBytes = estimateBytes(runStateContent);
    const runStateObs: Observation = {
      observationId: `obs-run-${run.runId}`,
      category: "RUN_STATE",
      provenance: {
        entityKind: "Run",
        entityId: run.runId,
        runId: run.runId,
        timestamp: run.updatedAt,
        isAuthoritativeRuntimeFact: true,
      },
      freshness: "CURRENT",
      priority: 100,
      content: runStateContent,
      contentHash: computeObservationContentHash(runStateContent),
      estimatedBytes: runStateBytes,
      estimatedTokens: estimateTokens(runStateBytes),
      isMandatory: true,
    };
    validateObservation(runStateObs);
    observations.push(runStateObs);

    // 2. MISSION_CONTEXT (Mandatory safety observation if contract binding exists)
    if (run.contractBinding) {
      const contract = this.stateStore.getContract(
        run.contractBinding.contractId,
        run.contractBinding.version
      );
      if (contract) {
        const task = this.stateStore.getTask(run.taskId);
        const contractContent = redactSensitiveData({
          contractId: contract.spec.contractId,
          taskId: contract.spec.taskId,
          version: contract.spec.version,
          status: contract.lifecycle.status,
          policy: contract.spec.policy,
          resourceLimits: contract.spec.resourceLimits,
          verificationSpecs: [...(contract.spec.verificationSpecs ?? [])],
          credentialScopes: [...(contract.spec.credentialScopes ?? [])],
          createdAt: contract.lifecycle.createdAt,
          activatedAt: contract.lifecycle.activatedAt,
          taskDetails: task
            ? {
                title: task.title,
                description: task.description,
                inputPayload: task.inputPayload,
              }
            : null,
        }) as Record<string, unknown>;

        const contractBytes = estimateBytes(contractContent);
        const contractObs: Observation = {
          observationId: `obs-contract-${contract.spec.contractId}-v${contract.spec.version}`,
          category: "MISSION_CONTEXT",
          provenance: {
            entityKind: "MissionContract",
            entityId: contract.spec.contractId,
            runId: run.runId,
            timestamp: contract.lifecycle.activatedAt ?? contract.lifecycle.createdAt,
            isAuthoritativeRuntimeFact: true,
          },
          freshness: "CURRENT",
          priority: 90,
          content: contractContent,
          contentHash: computeObservationContentHash(contractContent),
          estimatedBytes: contractBytes,
          estimatedTokens: estimateTokens(contractBytes),
          isMandatory: true,
        };
        validateObservation(contractObs);
        observations.push(contractObs);
      }
    }

    // 3. ACTIONS and ATTEMPTS
    const actions = this.stateStore.getActionsForRun(runId);
    const sortedActions = [...actions].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const lastAction = sortedActions.length > 0 ? sortedActions[sortedActions.length - 1] : undefined;
    const maxSeq = lastAction ? lastAction.sequenceNumber : 0;

    for (const action of sortedActions) {
      // Determine Action Freshness
      const freshness: ObservationFreshness =
        action.sequenceNumber === maxSeq
          ? "CURRENT"
          : maxSeq - action.sequenceNumber <= 3
          ? "RECENT"
          : "STALE";

      const actionPriority =
        50 + (freshness === "CURRENT" ? 15 : freshness === "RECENT" ? 5 : 0);

      const actionContent = redactSensitiveData({
        actionId: action.actionId,
        sequenceNumber: action.sequenceNumber,
        toolName: action.toolName,
        status: action.status,
        inputPayload: action.inputPayload,
        totalAttempts: action.totalAttempts,
        maxAttempts: action.maxAttempts,
        activeAttemptNumber: action.activeAttemptNumber,
        idempotency: action.idempotency,
        createdAt: action.createdAt,
        completedAt: action.completedAt,
      }) as Record<string, unknown>;

      const actionBytes = estimateBytes(actionContent);
      const actionObs: Observation = {
        observationId: `obs-action-${action.actionId}`,
        category: "ACTION_HISTORY",
        provenance: {
          entityKind: "Action",
          entityId: action.actionId,
          runId: run.runId,
          sequenceNumber: action.sequenceNumber,
          timestamp: action.createdAt,
          isAuthoritativeRuntimeFact: true,
        },
        freshness,
        priority: actionPriority,
        content: actionContent,
        contentHash: computeObservationContentHash(actionContent),
        estimatedBytes: actionBytes,
        estimatedTokens: estimateTokens(actionBytes),
        isMandatory: false,
      };
      validateObservation(actionObs);
      observations.push(actionObs);

      // ATTEMPTS for this Action
      const attempts = this.stateStore.getAttemptsForAction(action.actionId);
      const sortedAttempts = [...attempts].sort((a, b) => a.attemptNumber - b.attemptNumber);

      for (const attempt of sortedAttempts) {
        const isUnknown = attempt.status === "UNKNOWN";
        const isRunning = attempt.status === "RUNNING";
        const isActiveAttempt = action.activeAttemptNumber === attempt.attemptNumber;
        const attemptFreshness: ObservationFreshness = isActiveAttempt ? "CURRENT" : "RECENT";

        // Epistemic Uncertainty Preservation:
        // UNKNOWN attempts are mandatory safety observations with high priority!
        const attemptPriority = isUnknown ? 85 : 45 + (isRunning ? 15 : 0);

        let unknownReason: string | null = null;
        if (isUnknown) {
          if (
            attempt.errorPayload &&
            typeof attempt.errorPayload === "object" &&
            "reasonCode" in (attempt.errorPayload as Record<string, unknown>)
          ) {
            unknownReason = String(
              (attempt.errorPayload as Record<string, unknown>).reasonCode
            );
          } else if (
            attempt.errorPayload &&
            typeof attempt.errorPayload === "object" &&
            "reason" in (attempt.errorPayload as Record<string, unknown>)
          ) {
            unknownReason = String(
              (attempt.errorPayload as Record<string, unknown>).reason
            );
          } else {
            unknownReason = "UNSPECIFIED_EXECUTION_UNCERTAINTY";
          }
        }

        const attemptContent = redactSensitiveData({
          attemptId: attempt.attemptId,
          actionId: attempt.actionId,
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          executionOutcomeUncertain: isUnknown,
          unknownReason,
          idempotencyToken: attempt.idempotencyToken,
          startedAt: attempt.startedAt,
          completedAt: attempt.completedAt,
          durationMs: attempt.durationMs,
          exitCode: attempt.exitCode,
        }) as Record<string, unknown>;

        const attemptBytes = estimateBytes(attemptContent);
        const attemptObs: Observation = {
          observationId: `obs-attempt-${attempt.attemptId}`,
          category: "ATTEMPT_HISTORY",
          provenance: {
            entityKind: "Attempt",
            entityId: attempt.attemptId,
            runId: run.runId,
            sequenceNumber: attempt.attemptNumber,
            timestamp: attempt.startedAt,
            isAuthoritativeRuntimeFact: true,
          },
          freshness: attemptFreshness,
          priority: attemptPriority,
          content: attemptContent,
          contentHash: computeObservationContentHash(attemptContent),
          estimatedBytes: attemptBytes,
          estimatedTokens: estimateTokens(attemptBytes),
          isMandatory: isUnknown,
        };
        validateObservation(attemptObs);
        observations.push(attemptObs);

        // TOOL_RESULT observation if tool produced outputPayload
        if (attempt.outputPayload !== null && attempt.outputPayload !== undefined) {
          const resultPriority = 60 + (attemptFreshness === "CURRENT" ? 10 : 0);
          const resultContent = redactSensitiveData({
            attemptId: attempt.attemptId,
            actionId: attempt.actionId,
            toolName: action.toolName,
            output: attempt.outputPayload,
            exitCode: attempt.exitCode,
          }) as Record<string, unknown>;

          const resultBytes = estimateBytes(resultContent);
          const resultObs: Observation = {
            observationId: `obs-result-${attempt.attemptId}`,
            category: "TOOL_RESULT",
            provenance: {
              entityKind: "Attempt",
              entityId: attempt.attemptId,
              runId: run.runId,
              sequenceNumber: attempt.attemptNumber,
              timestamp: attempt.completedAt ?? attempt.startedAt,
              isAuthoritativeRuntimeFact: true,
            },
            freshness: attemptFreshness,
            priority: resultPriority,
            content: resultContent,
            contentHash: computeObservationContentHash(resultContent),
            estimatedBytes: resultBytes,
            estimatedTokens: estimateTokens(resultBytes),
            isMandatory: false,
          };
          validateObservation(resultObs);
          observations.push(resultObs);
        }

        // TOOL_ERROR observation if attempt failed, timed out, or encountered errorPayload
        if (
          !isUnknown &&
          (attempt.errorPayload !== null && attempt.errorPayload !== undefined ||
            attempt.status === "FAILED" ||
            attempt.status === "TIMED_OUT")
        ) {
          const errorContent = redactSensitiveData({
            attemptId: attempt.attemptId,
            actionId: attempt.actionId,
            toolName: action.toolName,
            status: attempt.status,
            error: attempt.errorPayload,
            exitCode: attempt.exitCode,
          }) as Record<string, unknown>;

          const errorBytes = estimateBytes(errorContent);
          const errorObs: Observation = {
            observationId: `obs-error-${attempt.attemptId}`,
            category: "TOOL_ERROR",
            provenance: {
              entityKind: "Attempt",
              entityId: attempt.attemptId,
              runId: run.runId,
              sequenceNumber: attempt.attemptNumber,
              timestamp: attempt.completedAt ?? attempt.startedAt,
              isAuthoritativeRuntimeFact: true,
            },
            freshness: attemptFreshness,
            priority: 80,
            content: errorContent,
            contentHash: computeObservationContentHash(errorContent),
            estimatedBytes: errorBytes,
            estimatedTokens: estimateTokens(errorBytes),
            isMandatory: false,
          };
          validateObservation(errorObs);
          observations.push(errorObs);
        }
      }
    }

    // 4. DOMAIN EVENTS
    const events = this.stateStore.getEventsForRun(runId);
    const sortedEvents = [...events].sort((a, b) => a.sequence - b.sequence);
    const totalEvents = sortedEvents.length;

    for (const event of sortedEvents) {
      const isRecent = event.sequence >= Math.max(1, totalEvents - 5);
      const eventFreshness: ObservationFreshness = isRecent ? "RECENT" : "STALE";

      if (event.eventType.startsWith("workspace.")) {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const wsContent = redactSensitiveData({
          eventType: event.eventType,
          sequence: event.sequence,
          workspaceId: payload["workspaceId"],
          rootDirectory: payload["rootDirectory"],
          hostDirectory: payload["hostDirectory"],
          status: payload["status"],
        }) as Record<string, unknown>;

        const wsBytes = estimateBytes(wsContent);
        const wsObs: Observation = {
          observationId: `obs-ws-${event.eventId}`,
          category: "WORKSPACE_STATE",
          provenance: {
            entityKind: "Workspace",
            entityId: (payload["workspaceId"] as string) ?? event.eventId,
            runId: run.runId,
            sequenceNumber: event.sequence,
            timestamp: event.timestamp,
            isAuthoritativeRuntimeFact: true,
          },
          freshness: eventFreshness,
          priority: 70,
          content: wsContent,
          contentHash: computeObservationContentHash(wsContent),
          estimatedBytes: wsBytes,
          estimatedTokens: estimateTokens(wsBytes),
          isMandatory: false,
        };
        validateObservation(wsObs);
        observations.push(wsObs);
      } else if (event.eventType.startsWith("verification.")) {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const verContent = redactSensitiveData({
          eventType: event.eventType,
          sequence: event.sequence,
          status: payload["status"],
          reason: payload["reason"],
          message: payload["message"] ?? payload["failureReason"],
          passed:
            payload["passed"] ??
            (payload["status"] === "VERIFIED"
              ? true
              : payload["status"] === "FAILED" || payload["status"] === "COMPLETION_REJECTED"
              ? false
              : undefined),
          failureReason:
            payload["failureReason"] ??
            (payload["status"] === "FAILED" || payload["status"] === "COMPLETION_REJECTED"
              ? payload["message"]
              : undefined),
          checks: payload["checks"],
          requirements: payload["requirements"],
          outstandingRequirements: payload["outstandingRequirements"],
        }) as Record<string, unknown>;

        const verBytes = estimateBytes(verContent);
        const verObs: Observation = {
          observationId: `obs-ver-${event.eventId}`,
          category: "VERIFICATION",
          provenance: {
            entityKind: "VerificationSpec",
            entityId: event.eventId,
            runId: run.runId,
            sequenceNumber: event.sequence,
            timestamp: event.timestamp,
            isAuthoritativeRuntimeFact: true,
          },
          freshness: isRecent ? "CURRENT" : "STALE",
          priority: 85,
          content: verContent,
          contentHash: computeObservationContentHash(verContent),
          estimatedBytes: verBytes,
          estimatedTokens: estimateTokens(verBytes),
          isMandatory: false,
        };
        validateObservation(verObs);
        observations.push(verObs);
      } else if (event.eventType.startsWith("evidence.")) {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const evContent = redactSensitiveData({
          eventType: event.eventType,
          sequence: event.sequence,
          evidenceId: payload["evidenceId"],
          type: payload["type"],
          summary: payload["summary"],
        }) as Record<string, unknown>;

        const evBytes = estimateBytes(evContent);
        const evObs: Observation = {
          observationId: `obs-evidence-${event.eventId}`,
          category: "EVIDENCE",
          provenance: {
            entityKind: "Evidence",
            entityId: (payload["evidenceId"] as string) ?? event.eventId,
            runId: run.runId,
            sequenceNumber: event.sequence,
            timestamp: event.timestamp,
            isAuthoritativeRuntimeFact: true,
          },
          freshness: eventFreshness,
          priority: 30,
          content: evContent,
          contentHash: computeObservationContentHash(evContent),
          estimatedBytes: evBytes,
          estimatedTokens: estimateTokens(evBytes),
          isMandatory: false,
        };
        validateObservation(evObs);
        observations.push(evObs);
      } else {
        const eventContent = redactSensitiveData({
          eventId: event.eventId,
          eventType: event.eventType,
          sequence: event.sequence,
          producer: event.producer,
          payload: event.payload,
        }) as Record<string, unknown>;

        const eventBytes = estimateBytes(eventContent);
        const eventObs: Observation = {
          observationId: `obs-event-${event.eventId}`,
          category: "SYSTEM_EVENT",
          provenance: {
            entityKind: "DomainEvent",
            entityId: event.eventId,
            runId: run.runId,
            sequenceNumber: event.sequence,
            timestamp: event.timestamp,
            isAuthoritativeRuntimeFact: true,
          },
          freshness: eventFreshness,
          priority: 20 + (isRecent ? 5 : 0),
          content: eventContent,
          contentHash: computeObservationContentHash(eventContent),
          estimatedBytes: eventBytes,
          estimatedTokens: estimateTokens(eventBytes),
          isMandatory: false,
        };
        validateObservation(eventObs);
        observations.push(eventObs);
      }
    }

    return Object.freeze(observations);
  }
}
