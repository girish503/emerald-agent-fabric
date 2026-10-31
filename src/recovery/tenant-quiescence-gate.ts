/**
 * Recovery pre-pass for ADR-0037: before the supervisor rolls a crashed run's workspace back, or the coordinator requeues
 * it and discards its workspace, every run that is about to be touched must be proven free of live tenant processes.
 *
 * Fail closed: a run is released to recovery ONLY when it needs no proof (its contract's isolation is IN_PROCESS, so a dead
 * worker leaves no tenant) or the quiescence port returned QUIESCENT. A missing port, an UNVERIFIED answer, a thrown error,
 * or an unreadable/unknown contract holds the run: no rollback, no requeue, no disposal; the next sweep retries it.
 */
import type { RunSnapshot } from "../domain/invariants.js";
import type { MissionContract } from "../domain/mission-contract.js";
import type { TenantModel, TenantQuiescencePort } from "../ports/tenant-quiescence.port.js";

export interface TenantQuiescenceConfig {
  /** Decides, from durable state only, whether a run can have left tenant processes. Must not trust the crashed worker. */
  readonly tenantModelOf: (run: RunSnapshot) => TenantModel;
  /** Required for runs whose model is ISOLATED_PROCESSES; without it those runs are held. */
  readonly port?: TenantQuiescencePort;
}

export interface HeldForTenants {
  readonly runId: string;
  readonly reason: string;
}

export interface TenantPrePassResult {
  readonly held: readonly HeldForTenants[];
  readonly heldRunIds: ReadonlySet<string>;
  /** Runs for which the port actually answered QUIESCENT. */
  readonly quiescedRunIds: readonly string[];
}

export async function runTenantQuiescencePrePass(
  runs: readonly RunSnapshot[],
  config: TenantQuiescenceConfig
): Promise<TenantPrePassResult> {
  const held: HeldForTenants[] = [];
  const quiesced: string[] = [];
  for (const run of runs) {
    let model: TenantModel;
    try {
      model = config.tenantModelOf(run);
    } catch (err: unknown) {
      held.push({ runId: run.runId, reason: `tenant model could not be determined: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (model === "NONE") continue;
    if (!config.port) {
      held.push({ runId: run.runId, reason: "run may have isolated tenant processes and no TenantQuiescencePort is configured" });
      continue;
    }
    try {
      const result = await config.port.quiesceRun(run.runId);
      if (result.status === "QUIESCENT") quiesced.push(run.runId);
      else held.push({ runId: run.runId, reason: `tenants not verified gone: ${result.reason}` });
    } catch (err: unknown) {
      held.push({ runId: run.runId, reason: `quiescence check failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { held, heldRunIds: new Set(held.map((h) => h.runId)), quiescedRunIds: quiesced };
}

/**
 * Tenant model from the run's BOUND mission contract policy (durable, independent of the worker). IN_PROCESS isolation means
 * operations ran inside the worker; anything else, a missing binding or a missing contract is treated as isolated (fail closed).
 */
export function tenantModelFromContract(
  getContract: (contractId: string, version: number) => MissionContract | null
): (run: RunSnapshot) => TenantModel {
  return (run) => {
    const binding = run.contractBinding;
    if (!binding) return "ISOLATED_PROCESSES";
    const contract = getContract(binding.contractId, binding.version);
    return contract?.spec.policy.isolationRequirement === "IN_PROCESS" ? "NONE" : "ISOLATED_PROCESSES";
  };
}
