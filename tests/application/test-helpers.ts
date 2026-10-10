import {
  createDefaultInProcessPolicy,
  createMissionContract,
  createResourceLimits,
  ExecutionPolicy,
  MissionContract,
  VerificationSpec,
} from "../../src/domain/index.js";
import { StateStorePort } from "../../src/ports/state-store.port.js";

export interface CreateAndActivateContractOptions {
  readonly contractId?: string;
  readonly version?: number;
  readonly policy?: ExecutionPolicy;
  readonly verificationSpecs?: readonly VerificationSpec[];
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
  const policy = options.policy ?? createDefaultInProcessPolicy(`policy-${taskId}`);
  const verificationSpecs = options.verificationSpecs ? [...options.verificationSpecs] : [];

  const contract = createMissionContract({
    contractId,
    version,
    taskId,
    policy,
    verificationSpecs,
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
