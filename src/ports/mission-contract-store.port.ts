import {
  ContractStatus,
  MissionContract,
} from "../domain/mission-contract.js";

export interface UpdateContractLifecycleParams {
  readonly contractId: string;
  readonly version: number;
  readonly status: ContractStatus;
  readonly activatedAt?: string | null;
  readonly revokedAt?: string | null;
  readonly revocationReason?: string | null;
}

/**
 * MissionContractStorePort defines the persistence contract for MissionContract aggregates.
 * Free of infrastructure or SQLite details.
 */
export interface MissionContractStorePort {
  /**
   * Persists a newly created MissionContract aggregate.
   * Rejects if (contract_id, version) already exists.
   */
  insertContract(contract: MissionContract): void;

  /**
   * Retrieves and reconstitutes a MissionContract by exact identity (contractId, version).
   * Verifies content-hash integrity; fails closed if tampered.
   */
  getContract(contractId: string, version: number): MissionContract | null;

  /**
   * Finds all contracts matching a specific canonical specification contentHash.
   * Verifies content-hash integrity; fails closed if tampered.
   */
  findContractsByHash(contentHash: string): readonly MissionContract[];

  /**
   * Finds all contracts associated with a task ID, optionally filtered by status.
   */
  findContractsByTaskId(taskId: string, status?: ContractStatus): readonly MissionContract[];

  /**
   * Activates a DRAFT contract atomically.
   * Enforces DRAFT -> ACTIVE domain transition.
   */
  activateContract(contractId: string, version: number, activatedAt?: string): MissionContract;

  /**
   * Revokes an ACTIVE contract atomically.
   * Enforces ACTIVE -> REVOKED domain transition.
   */
  revokeContract(
    contractId: string,
    version: number,
    reason?: string,
    revokedAt?: string
  ): MissionContract;

  /**
   * Updates the lifecycle metadata of an existing contract.
   * Specification and content_hash remain strictly immutable.
   */
  updateContractLifecycle(contract: MissionContract): void;
}
