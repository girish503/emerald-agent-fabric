/**
 * Reflex Proposal Interceptor Port for Emerald Agent Fabric.
 *
 * Defines the provider-independent seam where untrusted control recommendations
 * are evaluated on validated ActionProposals before reaching policy evaluation.
 *
 * Principles:
 * - Pure asynchronous evaluation interface
 * - Model and provider independent
 * - Accepts immutable observational inputs
 * - Returns typed control recommendation (ALLOW, REJECT, DEFER)
 * - Has ZERO direct execution authority and cannot bypass policy
 */

import type { ActionProposal } from "../domain/action-proposal.js";
import type { ReflexContext, ReflexDecision } from "../domain/reflex.js";

export interface ReflexPort {
  /**
   * Evaluates an already validated ActionProposal against an immutable observational ReflexContext.
   *
   * @param proposal Validated ActionProposal that has passed ProposalValidator
   * @param context Immutable observational context
   * @returns Pure untrusted control decision (ALLOW, REJECT, DEFER)
   */
  evaluate(
    proposal: ActionProposal,
    context: ReflexContext
  ): Promise<ReflexDecision>;
}
