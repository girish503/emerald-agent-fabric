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
import type { TenantLaunchCoordinatorPort, TenantLaunchGate } from "../ports/tenant-launch-coordinator.port.js";

export interface TenantQuiescenceConfig {
  /** Decides, from durable state only, whether a run can have left tenant processes. Must not trust the crashed worker. */
  readonly tenantModelOf: (run: RunSnapshot) => TenantModel;
  /** Required for runs whose model is ISOLATED_PROCESSES; without it those runs are held. */
  readonly port?: TenantQuiescencePort;
  /** Optional launch coordinator to acquire mutual exclusion before quiescence verification (ADR-0038). */
  readonly launchCoordinator?: TenantLaunchCoordinatorPort;
  readonly supervisorId?: string;
  readonly supervisorPid?: number;
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
  /**
   * Gate generation (acquisition token) under which each run's quiescence was established. Recovery authorizes an isolated
   * run only against this exact generation; the token is never re-read from the database on the caller's behalf.
   */
  readonly quiescedGateTokens: ReadonlyMap<string, string>;
  /** Releases any coordination gates acquired during the pre-pass. */
  readonly releaseGates?: () => Promise<void>;
}

export async function runTenantQuiescencePrePass(
  runs: readonly RunSnapshot[],
  config: TenantQuiescenceConfig
): Promise<TenantPrePassResult> {
  const held: HeldForTenants[] = [];
  const quiesced: string[] = [];
  const acquiredGates = new Map<string, TenantLaunchGate>();
  const gateTokens = new Map<string, string>();

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

    let gate: TenantLaunchGate | undefined;
    if (config.launchCoordinator) {
      try {
        gate = await config.launchCoordinator.acquire({
          runId: run.runId,
          holderType: "RECOVERY",
          holderId: config.supervisorId ?? "recovery-supervisor",
          leaseId: run.leaseId ?? "recovery",
          ttlMs: 30_000,
          timeoutMs: 5_000,
          ownerPid: config.supervisorPid ?? (typeof process !== "undefined" && process.pid ? process.pid : undefined),
        });
      } catch (err: unknown) {
        held.push({
          runId: run.runId,
          reason: `tenant launch gate acquisition failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
    }

    try {
      const result = await config.port.quiesceRun(run.runId);
      if (result.status === "QUIESCENT") {
        quiesced.push(run.runId);
        if (gate) {
          if (config.launchCoordinator && typeof config.launchCoordinator.markQuiescent === "function") {
            await config.launchCoordinator.markQuiescent(gate);
          }
          acquiredGates.set(run.runId, gate);
          gateTokens.set(run.runId, gate.token);
        }
      } else {
        held.push({ runId: run.runId, reason: `tenants not verified gone: ${result.reason}` });
        if (gate && config.launchCoordinator) {
          if (typeof config.launchCoordinator.quarantine === "function") {
            await config.launchCoordinator.quarantine(gate, result.reason).catch(() => {});
          }
        }
      }
    } catch (err: unknown) {
      held.push({ runId: run.runId, reason: `quiescence check failed: ${err instanceof Error ? err.message : String(err)}` });
      if (gate && config.launchCoordinator) {
        if (typeof config.launchCoordinator.quarantine === "function") {
          await config.launchCoordinator.quarantine(gate, err instanceof Error ? err.message : String(err)).catch(() => {});
        }
      }
    }
  }

  const releaseGates = async () => {
    if (!config.launchCoordinator || acquiredGates.size === 0) return;
    for (const [_, gate] of acquiredGates) {
      try {
        await config.launchCoordinator.release(gate);
      } catch {
        // ignore
      }
    }
    acquiredGates.clear();
  };

  // A run later held (e.g. markQuiescent failed) never carries a token, whatever the quiesced list says.
  for (const h of held) gateTokens.delete(h.runId);
  return {
    held,
    heldRunIds: new Set(held.map((h) => h.runId)),
    quiescedRunIds: quiesced,
    quiescedGateTokens: gateTokens,
    releaseGates,
  };
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
