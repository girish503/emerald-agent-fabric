import { Observation } from "../domain/context.js";

/**
 * ContextSourcePort defines the boundary for gathering candidate observations
 * from durable runtime state without mutating any state.
 */
export interface ContextSourcePort {
  /**
   * Reads durable state for a run and constructs candidate typed observations.
   *
   * Invariants:
   * 1. Must NOT mutate any operational state or append domain events.
   * 2. Must redact all sensitive fields (tokens, secrets, credentials).
   * 3. Must preserve epistemic uncertainty for UNKNOWN attempts.
   */
  gatherCandidateObservations(runId: string): Promise<readonly Observation[]>;
}
