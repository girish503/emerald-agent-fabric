import {
  createDefaultInProcessPolicy,
  createMissionContract,
  createResourceLimits,
} from "../../src/domain/index.js";
import type { ContractBinding } from "../../src/domain/invariants.js";
import type { MissionContractStorePort } from "../../src/ports/mission-contract-store.port.js";

/**
 * Registers an ACTIVE IN_PROCESS contract for `taskId` and returns the binding for a run seeded directly into the store.
 * IN_PROCESS runs leave no tenant processes behind, so recovery does not require a QUIESCED launch gate for them
 * (an unbound run is treated as possibly isolated and is held until quiescence is proven). Call after inserting the task.
 */
export function inProcessBinding(store: MissionContractStorePort, taskId: string): ContractBinding {
  const contract = createMissionContract({
    contractId: `contract-${taskId}`,
    version: 1,
    taskId,
    policy: createDefaultInProcessPolicy(`policy-${taskId}`),
    verificationSpecs: [],
    resourceLimits: createResourceLimits({ timeoutMs: 30000, maxAttempts: 3, maxOutputBytes: 1048576 }),
    credentialScopes: ["test:scope"],
  });
  store.insertContract(contract);
  const active = store.activateContract(contract.spec.contractId, contract.spec.version);
  return { contractId: active.spec.contractId, version: active.spec.version, contentHash: active.contentHash };
}
