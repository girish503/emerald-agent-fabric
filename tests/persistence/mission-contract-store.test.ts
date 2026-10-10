import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import {
  activateMissionContract,
  canonicalJsonStringify,
  createDefaultInProcessPolicy,
  createMissionContract,
  createResourceLimits,
  createVerificationSpec,
  InvalidMissionContractError,
  MissionContract,
} from "../../src/domain/index.js";

describe("MissionContract Persistence Store (Task 1.8B)", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  const sampleTaskId = "task-contract-1";

  const defaultPolicy = createDefaultInProcessPolicy("policy-persist-1");
  const defaultLimits = createResourceLimits({
    timeoutMs: 30000,
    maxAttempts: 3,
    maxOutputBytes: 1048576,
  });
  const defaultVerificationSpec = createVerificationSpec({
    specId: "vspec-persist-1",
    ruleKind: "EXACT_OUTPUT_MATCH",
    expectedValue: { status: "success" },
  });

  const createTestContract = (
    contractId = "contract-1",
    version = 1,
    taskId = sampleTaskId,
    scopes: readonly string[] = ["github:repo:read", "aws:s3:read"]
  ): MissionContract => {
    return createMissionContract({
      contractId,
      version,
      taskId,
      policy: defaultPolicy,
      verificationSpecs: [defaultVerificationSpec],
      resourceLimits: defaultLimits,
      credentialScopes: scopes,
    });
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-contract-store-test-"));
    dbPath = path.join(tempDir, "test.db");
    store = new SqliteStateStore({ location: dbPath });

    // Seed task in SQLite
    store.transaction((tx) => {
      tx.insertTask({
        taskId: sampleTaskId,
        title: "Test Task for Contract Persistence",
        description: "Task used for foreign key tests",
        inputPayload: { query: "test" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  describe("1. Valid Contract Persistence & Reconstitution", () => {
    it("persists and reconstitutes a valid MissionContract with identical identity and state", () => {
      const contract = createTestContract();

      store.insertContract(contract);

      const retrieved = store.getContract(contract.spec.contractId, contract.spec.version);
      expect(retrieved).not.toBeNull();
      if (!retrieved) return;

      expect(retrieved.spec.contractId).toBe(contract.spec.contractId);
      expect(retrieved.spec.version).toBe(contract.spec.version);
      expect(retrieved.spec.taskId).toBe(contract.spec.taskId);
      expect(retrieved.contentHash).toBe(contract.contentHash);

      // Deep equality of spec
      expect(retrieved.spec.policy.policyId).toBe(contract.spec.policy.policyId);
      expect(retrieved.spec.resourceLimits).toEqual(contract.spec.resourceLimits);
      expect(retrieved.spec.verificationSpecs).toEqual(contract.spec.verificationSpecs);
      expect(retrieved.spec.credentialScopes).toEqual(contract.spec.credentialScopes);

      // Lifecycle status
      expect(retrieved.lifecycle.status).toBe("DRAFT");
      expect(retrieved.lifecycle.createdAt).toBe(contract.lifecycle.createdAt);
      expect(retrieved.lifecycle.activatedAt).toBeNull();
      expect(retrieved.lifecycle.revokedAt).toBeNull();
      expect(retrieved.lifecycle.revocationReason).toBeNull();

      // Deep immutability of reconstituted aggregate
      expect(Object.isFrozen(retrieved)).toBe(true);
      expect(Object.isFrozen(retrieved.spec)).toBe(true);
      expect(Object.isFrozen(retrieved.lifecycle)).toBe(true);
      expect(Object.isFrozen(retrieved.spec.credentialScopes)).toBe(true);
    });

    it("returns null when contract does not exist", () => {
      const result = store.getContract("non-existent-contract", 1);
      expect(result).toBeNull();
    });
  });

  describe("2. Retrieval by Content Hash", () => {
    it("finds matching contract by contentHash in a single-element array", () => {
      const contract = createTestContract();
      store.insertContract(contract);

      const retrieved = store.findContractsByHash(contract.contentHash);
      expect(retrieved.length).toBe(1);
      expect(retrieved[0]?.spec.contractId).toBe(contract.spec.contractId);
      expect(retrieved[0]?.contentHash).toBe(contract.contentHash);
    });

    it("returns multiple contracts when multiple identities share the same specification and contentHash", () => {
      const contractA = createTestContract("contract-A", 1);
      store.insertContract(contractA);

      // Persist another contract identity (contract-B v7) sharing the exact same canonical spec and contentHash in SQLite
      const rawDb = createSqliteClient({ location: dbPath });
      try {
        rawDb
          .prepare(
            `INSERT INTO mission_contracts (contract_id, version, task_id, status, content_hash, canonical_spec, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "contract-B",
            7,
            sampleTaskId,
            "DRAFT",
            contractA.contentHash,
            canonicalJsonStringify(contractA.spec),
            new Date().toISOString()
          );
      } finally {
        rawDb.close();
      }

      const matches = store.findContractsByHash(contractA.contentHash);
      expect(matches.length).toBe(2);
      expect(matches[0]?.contentHash).toBe(contractA.contentHash);
      expect(matches[1]?.contentHash).toBe(contractA.contentHash);

      // Confirm both remain independently addressable by exact identity (contractId, version)
      const getA = store.getContract("contract-A", 1);
      const getB = store.getContract("contract-B", 7);
      expect(getA).not.toBeNull();
      expect(getB).not.toBeNull();
      expect(getA?.contentHash).toBe(contractA.contentHash);
      expect(getB?.contentHash).toBe(contractA.contentHash);
    });

    it("returns empty array when querying by unknown contentHash", () => {
      const unknownHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      const retrieved = store.findContractsByHash(unknownHash);
      expect(retrieved).toEqual([]);
      expect(retrieved.length).toBe(0);
    });
  });

  describe("3. Querying by Task ID", () => {
    it("finds all contract versions for a task in version ASC order", () => {
      const c1 = createTestContract("contract-app-1", 1);
      const c2 = createTestContract("contract-app-1", 2);

      store.insertContract(c1);
      store.insertContract(c2);

      const results = store.findContractsByTaskId(sampleTaskId);
      expect(results.length).toBe(2);
      expect(results[0]?.spec.version).toBe(1);
      expect(results[1]?.spec.version).toBe(2);
    });

    it("filters contracts by status when status parameter is supplied", () => {
      const c1 = createTestContract("contract-app-1", 1);
      const c2 = createTestContract("contract-app-2", 1);

      store.insertContract(c1);
      store.insertContract(c2);

      store.activateContract("contract-app-1", 1, new Date().toISOString());

      const activeContracts = store.findContractsByTaskId(sampleTaskId, "ACTIVE");
      expect(activeContracts.length).toBe(1);
      expect(activeContracts[0]?.spec.contractId).toBe("contract-app-1");

      const draftContracts = store.findContractsByTaskId(sampleTaskId, "DRAFT");
      expect(draftContracts.length).toBe(1);
      expect(draftContracts[0]?.spec.contractId).toBe("contract-app-2");
    });

    it("returns empty array for task with no contracts", () => {
      const results = store.findContractsByTaskId("task-without-contracts");
      expect(results).toEqual([]);
    });
  });

  describe("4. Identity Constraints & Referential Integrity", () => {
    it("rejects duplicate (contractId, version) with primary key constraint error", () => {
      const contract1 = createTestContract("contract-dup-1", 1);
      const contract2 = createTestContract("contract-dup-1", 1);

      store.insertContract(contract1);

      expect(() => {
        store.insertContract(contract2);
      }).toThrow(InvalidMissionContractError);
      expect(() => {
        store.insertContract(contract2);
      }).toThrow(/already exists/);

      // Verify underlying SQLite database PRIMARY KEY constraint
      const rawDb = createSqliteClient({ location: dbPath });
      try {
        expect(() => {
          rawDb
            .prepare(
              `INSERT INTO mission_contracts (contract_id, version, task_id, status, content_hash, canonical_spec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              "contract-dup-1",
              1,
              sampleTaskId,
              "DRAFT",
              "hash-123",
              "{}",
              new Date().toISOString()
            );
        }).toThrow(/UNIQUE constraint failed: mission_contracts\.contract_id, mission_contracts\.version/);
      } finally {
        rawDb.close();
      }
    });

    it("enforces foreign key constraint referencing tasks table", () => {
      const orphanContract = createTestContract("contract-orphan", 1, "non-existent-task-id");

      expect(() => {
        store.insertContract(orphanContract);
      }).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  describe("5. Credential Scope Preservation", () => {
    it("preserves sorted, deduplicated, lowercased credential scopes across SQLite persistence", () => {
      const contract = createTestContract("contract-scopes", 1, sampleTaskId, [
        "github:repo:write",
        "github:repo:read",
        "aws:s3:read",
      ]);

      store.insertContract(contract);

      const retrieved = store.getContract(contract.spec.contractId, contract.spec.version);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.spec.credentialScopes).toEqual([
        "aws:s3:read",
        "github:repo:read",
        "github:repo:write",
      ]);
    });
  });

  describe("6. Fail-Closed Tamper Detection on Reconstitution", () => {
    it("throws InvalidMissionContractError if canonical_spec is modified directly in database", () => {
      const contract = createTestContract();
      store.insertContract(contract);

      // Tamper directly via raw connection
      const rawDb = createSqliteClient({ location: dbPath });
      try {
        const row = rawDb
          .prepare(`SELECT canonical_spec FROM mission_contracts WHERE contract_id = ?`)
          .get(contract.spec.contractId) as { canonical_spec: string };

        const tamperedSpec = JSON.parse(row.canonical_spec);
        tamperedSpec.resourceLimits.timeoutMs = 9999999; // Tampered limit

        rawDb
          .prepare(`UPDATE mission_contracts SET canonical_spec = ? WHERE contract_id = ?`)
          .run(JSON.stringify(tamperedSpec), contract.spec.contractId);
      } finally {
        rawDb.close();
      }

      // Reconstitution must detect hash mismatch and fail closed
      expect(() => {
        store.getContract(contract.spec.contractId, contract.spec.version);
      }).toThrow(InvalidMissionContractError);
      expect(() => {
        store.getContract(contract.spec.contractId, contract.spec.version);
      }).toThrow(/Content hash mismatch/);
    });

    it("throws InvalidMissionContractError if content_hash column is tampered in database", () => {
      const contract = createTestContract();
      store.insertContract(contract);

      const rawDb = createSqliteClient({ location: dbPath });
      try {
        rawDb
          .prepare(`UPDATE mission_contracts SET content_hash = ? WHERE contract_id = ?`)
          .run(
            "bad0000000000000000000000000000000000000000000000000000000000000",
            contract.spec.contractId
          );
      } finally {
        rawDb.close();
      }

      expect(() => {
        store.getContract(contract.spec.contractId, contract.spec.version);
      }).toThrow(InvalidMissionContractError);
      expect(() => {
        store.getContract(contract.spec.contractId, contract.spec.version);
      }).toThrow(/Content hash mismatch/);
    });

    it("throws InvalidMissionContractError if canonical_spec contains malformed JSON", () => {
      const contract = createTestContract();
      store.insertContract(contract);

      const rawDb = createSqliteClient({ location: dbPath });
      try {
        rawDb
          .prepare(`UPDATE mission_contracts SET canonical_spec = ? WHERE contract_id = ?`)
          .run("{ broken json", contract.spec.contractId);
      } finally {
        rawDb.close();
      }

      expect(() => {
        store.getContract(contract.spec.contractId, contract.spec.version);
      }).toThrow(InvalidMissionContractError);
      expect(() => {
        store.getContract(contract.spec.contractId, contract.spec.version);
      }).toThrow(/Corrupted canonical_spec JSON/);
    });

    it("throws InvalidMissionContractError if canonical_spec is injected with secret-bearing field", () => {
      const contract = createTestContract();
      store.insertContract(contract);

      const rawDb = createSqliteClient({ location: dbPath });
      try {
        const row = rawDb
          .prepare(`SELECT canonical_spec FROM mission_contracts WHERE contract_id = ?`)
          .get(contract.spec.contractId) as { canonical_spec: string };

        const tamperedSpec = JSON.parse(row.canonical_spec);
        tamperedSpec.apiKey = "secret-token-123"; // Injected secret-bearing field

        rawDb
          .prepare(`UPDATE mission_contracts SET canonical_spec = ? WHERE contract_id = ?`)
          .run(JSON.stringify(tamperedSpec), contract.spec.contractId);
      } finally {
        rawDb.close();
      }

      expect(() => {
        store.getContract(contract.spec.contractId, contract.spec.version);
      }).toThrow(InvalidMissionContractError);
      expect(() => {
        store.getContract(contract.spec.contractId, contract.spec.version);
      }).toThrow(/raw secrets or sensitive fields/);
    });
  });

  describe("7. Lifecycle Transitions & Content Hash Invariance", () => {
    it("activates DRAFT contract and preserves contentHash invariant", () => {
      const contract = createTestContract();
      store.insertContract(contract);

      const activatedAtIso = new Date().toISOString();
      const activated = store.activateContract(
        contract.spec.contractId,
        contract.spec.version,
        activatedAtIso
      );

      expect(activated.lifecycle.status).toBe("ACTIVE");
      expect(activated.lifecycle.activatedAt).toBe(activatedAtIso);
      expect(activated.lifecycle.revokedAt).toBeNull();
      expect(activated.contentHash).toBe(contract.contentHash);

      // Verify persisted state
      const reloaded = store.getContract(contract.spec.contractId, contract.spec.version);
      expect(reloaded).not.toBeNull();
      expect(reloaded?.lifecycle.status).toBe("ACTIVE");
      expect(reloaded?.lifecycle.activatedAt).toBe(activatedAtIso);
      expect(reloaded?.contentHash).toBe(contract.contentHash);
    });

    it("revokes ACTIVE contract and preserves contentHash invariant", () => {
      const contract = createTestContract();
      store.insertContract(contract);

      const activatedAt = new Date().toISOString();
      store.activateContract(contract.spec.contractId, contract.spec.version, activatedAt);

      const revokedAt = new Date().toISOString();
      const revoked = store.revokeContract(
        contract.spec.contractId,
        contract.spec.version,
        "Security policy violation detected",
        revokedAt
      );

      expect(revoked.lifecycle.status).toBe("REVOKED");
      expect(revoked.lifecycle.revokedAt).toBe(revokedAt);
      expect(revoked.lifecycle.revocationReason).toBe("Security policy violation detected");
      expect(revoked.contentHash).toBe(contract.contentHash);

      // Verify persisted state
      const reloaded = store.getContract(contract.spec.contractId, contract.spec.version);
      expect(reloaded).not.toBeNull();
      expect(reloaded?.lifecycle.status).toBe("REVOKED");
      expect(reloaded?.lifecycle.revokedAt).toBe(revokedAt);
      expect(reloaded?.lifecycle.revocationReason).toBe("Security policy violation detected");
      expect(reloaded?.contentHash).toBe(contract.contentHash);
    });

    it("rejects illegal lifecycle transition (REVOKED -> ACTIVE)", () => {
      const contract = createTestContract();
      store.insertContract(contract);

      store.activateContract(contract.spec.contractId, contract.spec.version, new Date().toISOString());
      store.revokeContract(
        contract.spec.contractId,
        contract.spec.version,
        "Revoked",
        new Date().toISOString()
      );

      expect(() => {
        store.activateContract(
          contract.spec.contractId,
          contract.spec.version,
          new Date().toISOString()
        );
      }).toThrow(InvalidMissionContractError);
      expect(() => {
        store.activateContract(
          contract.spec.contractId,
          contract.spec.version,
          new Date().toISOString()
        );
      }).toThrow(/Cannot activate contract .* in status 'REVOKED'/);
    });

    it("rejects revoking a DRAFT contract directly", () => {
      const contract = createTestContract();
      store.insertContract(contract);

      expect(() => {
        store.revokeContract(
          contract.spec.contractId,
          contract.spec.version,
          "Attempted invalid revocation",
          new Date().toISOString()
        );
      }).toThrow(InvalidMissionContractError);
      expect(() => {
        store.revokeContract(
          contract.spec.contractId,
          contract.spec.version,
          "Attempted invalid revocation",
          new Date().toISOString()
        );
      }).toThrow(/Cannot revoke contract .* in status 'DRAFT'/);
    });

    it("throws error when activating non-existent contract", () => {
      expect(() => {
        store.activateContract("non-existent", 1, new Date().toISOString());
      }).toThrow(InvalidMissionContractError);
    });

    it("throws error when revoking non-existent contract", () => {
      expect(() => {
        store.revokeContract("non-existent", 1, "Missing", new Date().toISOString());
      }).toThrow(InvalidMissionContractError);
    });

    it("updates contract lifecycle directly via updateContractLifecycle", () => {
      const contract = createTestContract();
      store.insertContract(contract);

      const activatedAt = new Date().toISOString();
      const activatedContract = activateMissionContract(contract, activatedAt);
      store.updateContractLifecycle(activatedContract);

      const retrieved = store.getContract(contract.spec.contractId, contract.spec.version);
      expect(retrieved?.lifecycle.status).toBe("ACTIVE");
      expect(retrieved?.lifecycle.activatedAt).toBe(activatedAt);
    });

    it("throws error when updateContractLifecycle targets non-existent contract", () => {
      const contract = createTestContract("ghost-contract", 1);
      expect(() => {
        store.updateContractLifecycle(contract);
      }).toThrow(InvalidMissionContractError);
    });
  });

  describe("8. Transaction Atomicity & Rollback", () => {
    it("rolls back contract insertion when transaction aborts", () => {
      const contract = createTestContract("contract-rollback-1", 1);

      expect(() => {
        store.transaction((tx) => {
          tx.insertContract(contract);
          throw new Error("Simulated transactional error");
        });
      }).toThrow("Simulated transactional error");

      const retrieved = store.getContract(contract.spec.contractId, contract.spec.version);
      expect(retrieved).toBeNull();
    });

    it("commits task insertion and contract insertion atomically", () => {
      const newTaskId = "task-atomic-bundle";
      const contract = createTestContract("contract-atomic-1", 1, newTaskId);

      store.transaction((tx) => {
        tx.insertTask({
          taskId: newTaskId,
          title: "Atomic Task",
          description: "Created in same tx as contract",
          inputPayload: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        tx.insertContract(contract);
      });

      const retrievedTask = store.getTask(newTaskId);
      const retrievedContract = store.getContract(contract.spec.contractId, contract.spec.version);

      expect(retrievedTask).not.toBeNull();
      expect(retrievedContract).not.toBeNull();
    });
  });
});
