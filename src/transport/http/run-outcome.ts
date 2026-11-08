/**
 * Authoritative run outcome derivation (Track B transport).
 *
 * The API must never report VERIFIED_SUCCESS because a worker said so, an in-memory status says COMPLETED,
 * or a generic terminal event was seen. The only input accepted here is the durable event stream of the run
 * (verification.completed / verification.rejected / verification.unverified_completion_authorized), which is
 * written by the runtime's completion evidence gate (Milestone 2.23). With no durable events the outcome is
 * unknown (null), never inferred.
 *
 * This is a conservative read-side approximation of the runtime gate. It cannot make an unverified run look
 * verified: VERIFIED_SUCCESS requires an explicit, verified specification set with a VERIFIED durable verification
 * result for every required spec, with no later rejection and no unverified-completion authorization.
 */

import type { TrialFinalOutcome } from "../../domain/evaluation.js";

export interface DurableEventView {
  readonly sequence: number;
  readonly eventType: string;
  readonly payload?: unknown;
}

export interface DeriveAuthoritativeOutcomeOptions {
  readonly requiredSpecIds?: readonly string[] | Set<string>;
  readonly contractLoaded?: boolean;
  readonly allowUnverifiedCompletion?: boolean;
}

function payloadOf(event: DurableEventView): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
}

export function deriveAuthoritativeOutcome(
  status: string,
  events: readonly DurableEventView[] | undefined,
  options?: DeriveAuthoritativeOutcomeOptions
): TrialFinalOutcome | null {
  if (!events) return null; // no durable evidence source: unknown, never inferred

  switch (status) {
    case "TIMED_OUT":
      return "TIMEOUT";
    case "CANCELLED":
      return "BLOCKED";
    case "FAILED": {
      const unverifiable = events.some(
        (e) => e.eventType === "verification.rejected" && payloadOf(e).status === "COMPLETION_UNVERIFIABLE"
      );
      return unverifiable ? "COMPLETION_UNVERIFIABLE" : "EXECUTION_FAILURE";
    }
    case "COMPLETED": {
      if (options?.allowUnverifiedCompletion === true || events.some((e) => e.eventType === "verification.unverified_completion_authorized")) {
        return "COMPLETION_UNVERIFIABLE";
      }
      if (options?.contractLoaded === false) {
        return "COMPLETION_UNVERIFIABLE";
      }

      const latestBySpec = new Map<string, { status: unknown; sequence: number }>();
      let lastVerificationSequence = -1;
      for (const e of events) {
        if (e.eventType !== "verification.completed") continue;
        const p = payloadOf(e);
        const specId = typeof p.specId === "string" ? p.specId : "";
        if (!specId) continue;
        latestBySpec.set(specId, { status: p.status, sequence: e.sequence });
        lastVerificationSequence = Math.max(lastVerificationSequence, e.sequence);
      }

      const rejectedAfter = events.some((e) => e.eventType === "verification.rejected" && e.sequence > lastVerificationSequence);
      if (rejectedAfter) {
        return "COMPLETION_UNVERIFIABLE";
      }

      // When requiredSpecIds is provided, strictly evaluate against the authoritative specification set.
      if (options?.requiredSpecIds !== undefined) {
        const required = Array.from(options.requiredSpecIds);
        // An empty required specification set cannot prove success.
        if (required.length === 0) {
          return "COMPLETION_UNVERIFIABLE";
        }
        for (const specId of required) {
          const res = latestBySpec.get(specId);
          if (!res || res.status !== "VERIFIED") {
            return "COMPLETION_UNVERIFIABLE";
          }
        }
        for (const res of latestBySpec.values()) {
          if (res.status !== "VERIFIED") {
            return "COMPLETION_UNVERIFIABLE";
          }
        }
        return "VERIFIED_SUCCESS";
      }

      // Backward-compatible fallback when requiredSpecIds is omitted: infer from verified evidence.
      const allVerified = latestBySpec.size > 0 && [...latestBySpec.values()].every((r) => r.status === "VERIFIED");
      if (allVerified) return "VERIFIED_SUCCESS";

      // Terminal COMPLETED without authoritative verification evidence is never a verified success.
      return "COMPLETION_UNVERIFIABLE";
    }
    default:
      return null; // non-terminal
  }
}
