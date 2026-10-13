/**
 * Deterministic No-Op implementation of ReflexPort for Emerald Agent Fabric.
 *
 * Purpose:
 * Proves the architectural insertion point and provides a safe default for
 * baseline execution without altering proposals, metrics, or governance.
 *
 * Guarantees:
 * - Deterministically returns ALLOW with reasonCode NO_INTERVENTION.
 * - Does not modify proposals.
 * - Does not modify context.
 * - Does not invoke model providers or LLMs.
 * - Does not invoke tools or Docker containers.
 * - Does not perform hidden retries or state mutations.
 */

import type { ActionProposal } from "../../domain/action-proposal.js";
import {
  type ReflexContext,
  type ReflexDecision,
  validateReflexContext,
} from "../../domain/reflex.js";
import type { ReflexPort } from "../../ports/reflex.port.js";

export class NoopReflex implements ReflexPort {
  readonly name = "NoopReflex";

  async evaluate(
    _proposal: ActionProposal,
    context: ReflexContext
  ): Promise<ReflexDecision> {
    // Contract integrity check: validate context without mutating it
    validateReflexContext(context);

    return Object.freeze({
      decision: "ALLOW",
      reasonCode: "NO_INTERVENTION",
      rationale: "No intervention required",
    });
  }
}
