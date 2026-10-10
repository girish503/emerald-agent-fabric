import {
  createDefaultInProcessPolicy,
  createMissionContract,
  createResourceLimits,
  createVerificationSpec,
  MissionContract,
} from "../../src/domain/index.js";
import { StateStorePort } from "../../src/ports/state-store.port.js";

export interface CreateAndActivateContractOptions {
  readonly contractId?: string;
  readonly version?: number;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly maxOutputBytes?: number;
  readonly scopes?: readonly string[];
}

export function createAndActivateContract(
  store: StateStorePort,
  taskId: string,
  options: CreateAndActivateContractOptions = {}
): MissionContract {
  const contractId = options.contractId ?? `contract-${taskId}`;
  const version = options.version ?? 1;
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxAttempts = options.maxAttempts ?? 3;
  const maxOutputBytes = options.maxOutputBytes ?? 1048576;
  const scopes = options.scopes ?? ["test:scope"];

  const contract = createMissionContract({
    contractId,
    version,
    taskId,
    policy: createDefaultInProcessPolicy(`policy-${taskId}`),
    verificationSpecs: [
      createVerificationSpec({
        specId: `vspec-${taskId}`,
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: { status: "success" },
      }),
    ],
    resourceLimits: createResourceLimits({
      timeoutMs,
      maxAttempts,
      maxOutputBytes,
    }),
    credentialScopes: scopes,
  });

  store.insertContract(contract);
  return store.activateContract(contractId, version);
}
