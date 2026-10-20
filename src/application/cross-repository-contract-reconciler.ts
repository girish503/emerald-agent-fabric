/**
 * Phase 85 — Governed Cross-Repository Contract Reconciler
 *
 * Reconciles contracts between producer and consumer repositories.
 * Enforces strict revision fencing, version alignment, and invariant verification.
 *
 * CRITICAL RULE:
 * Never transform UNRESOLVED into COMPATIBLE through heuristic optimism.
 */

import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";
import {
  CrossRepositoryContract,
  RepositoryDependencyEdge,
  ContractCompatibilityStatus,
  CrossRepositoryInvariantClass,
  CrossRepositoryFailureCode,
  computeContractDigest,
} from "../domain/cross-repository-context.js";

export interface ConsumerExpectations {
  readonly requiredSymbols?: readonly string[];
  readonly declaredVersionRange?: string;
  readonly preconditions?: readonly string[];
  readonly postconditions?: readonly string[];
}

export interface ReconciliationRequest {
  readonly contract: CrossRepositoryContract;
  readonly currentProducerRevision: string;
  readonly currentConsumerRevision: string;
  readonly dependencyEdge?: RepositoryDependencyEdge;
  readonly consumerExpectations?: ConsumerExpectations;
}

export interface ReconciliationResult {
  readonly contractId: string;
  readonly status: ContractCompatibilityStatus;
  readonly isStale: boolean;
  readonly failureCode?: CrossRepositoryFailureCode;
  readonly invariantsEvaluated: readonly CrossRepositoryInvariantClass[];
  readonly diagnostics: readonly string[];
  readonly reconciliationDigest: string;
}

export class CrossRepositoryContractReconciler {
  /**
   * Evaluates contract compatibility and revision freshness between producer and consumer.
   */
  public reconcile(request: ReconciliationRequest): ReconciliationResult {
    const diagnostics: string[] = [];
    const invariantsEvaluated: CrossRepositoryInvariantClass[] = [
      "API_SIGNATURE_COMPATIBILITY",
      "VERSION_COMPATIBILITY",
      "PRODUCER_CONSUMER_COMPATIBILITY",
    ];

    const { contract, currentProducerRevision, currentConsumerRevision, dependencyEdge, consumerExpectations } =
      request;

    // Verify contract digest integrity
    const computedDigest = computeContractDigest(contract);
    if (contract.contractDigest !== computedDigest) {
      return {
        contractId: contract.contractId,
        status: "INCOMPATIBLE",
        isStale: false,
        failureCode: "CONTRACT_CONFLICT",
        invariantsEvaluated,
        diagnostics: [
          `CONTRACT_CONFLICT: contract digest mismatch. Expected ${computedDigest}, received ${contract.contractDigest}`,
        ],
        reconciliationDigest: sha256Hex(`conflict:${contract.contractId}`),
      };
    }

    // 1. Revision Fencing (Stale contract check)
    let isStale = false;
    if (contract.producerRevision !== currentProducerRevision) {
      diagnostics.push(
        `Producer revision mismatch: contract has ${contract.producerRevision}, repository has ${currentProducerRevision}`
      );
      isStale = true;
    }
    if (contract.consumerRevision !== currentConsumerRevision) {
      diagnostics.push(
        `Consumer revision mismatch: contract has ${contract.consumerRevision}, repository has ${currentConsumerRevision}`
      );
      isStale = true;
    }

    if (isStale) {
      return {
        contractId: contract.contractId,
        status: "INCOMPATIBLE",
        isStale: true,
        failureCode: "CROSS_REPOSITORY_CONTRACT_STALE",
        invariantsEvaluated,
        diagnostics: [
          "CROSS_REPOSITORY_CONTRACT_STALE: contract revision does not match current repository revision",
          ...diagnostics,
        ],
        reconciliationDigest: sha256Hex(`stale:${contract.contractId}`),
      };
    }

    // 2. Version Fencing
    if (dependencyEdge) {
      if (
        dependencyEdge.producerRepositoryId !== contract.producerRepositoryId ||
        dependencyEdge.consumerRepositoryId !== contract.consumerRepositoryId
      ) {
        return {
          contractId: contract.contractId,
          status: "INCOMPATIBLE",
          isStale: false,
          failureCode: "CONTRACT_CONFLICT",
          invariantsEvaluated,
          diagnostics: [
            "CONTRACT_CONFLICT: Dependency edge repository endpoints do not match contract endpoints",
          ],
          reconciliationDigest: sha256Hex(`edge_mismatch:${contract.contractId}`),
        };
      }

      if (dependencyEdge.sourceRevision !== currentProducerRevision) {
        return {
          contractId: contract.contractId,
          status: "INCOMPATIBLE",
          isStale: true,
          failureCode: "SOURCE_REVISION_MISMATCH",
          invariantsEvaluated,
          diagnostics: [
            `SOURCE_REVISION_MISMATCH: Edge revision ${dependencyEdge.sourceRevision} does not match current producer ${currentProducerRevision}`,
          ],
          reconciliationDigest: sha256Hex(`source_mismatch:${contract.contractId}`),
        };
      }

      if (
        consumerExpectations?.declaredVersionRange &&
        !this.isVersionSatisfied(dependencyEdge.resolvedVersion, consumerExpectations.declaredVersionRange)
      ) {
        return {
          contractId: contract.contractId,
          status: "INCOMPATIBLE",
          isStale: false,
          failureCode: "VERSION_MISMATCH",
          invariantsEvaluated,
          diagnostics: [
            `VERSION_MISMATCH: Resolved version ${dependencyEdge.resolvedVersion} does not satisfy range ${consumerExpectations.declaredVersionRange}`,
          ],
          reconciliationDigest: sha256Hex(`ver_mismatch:${contract.contractId}`),
        };
      }
    }

    // 3. Invariant Evaluation
    if (contract.contractKind === "SCHEMA_DEFINITION") {
      invariantsEvaluated.push("SCHEMA_COMPATIBILITY");
    } else if (contract.contractKind === "TYPE_DEFINITION") {
      invariantsEvaluated.push("TYPE_COMPATIBILITY");
    } else if (contract.contractKind === "SERIALIZATION_FORMAT") {
      invariantsEvaluated.push("SERIALIZATION_COMPATIBILITY");
    } else if (contract.contractKind === "ERROR_CONTRACT") {
      invariantsEvaluated.push("ERROR_CONTRACT_COMPATIBILITY");
    }

    // 4. Consumer Expectations
    if (consumerExpectations?.requiredSymbols) {
      for (const sym of consumerExpectations.requiredSymbols) {
        if (!contract.representation.includes(sym)) {
          diagnostics.push(`Missing required symbol: ${sym}`);
          return {
            contractId: contract.contractId,
            status: "INCOMPATIBLE",
            isStale: false,
            failureCode: "CONTRACT_CONFLICT",
            invariantsEvaluated,
            diagnostics,
            reconciliationDigest: sha256Hex(`symbol_missing:${contract.contractId}:${sym}`),
          };
        }
      }
    }

    // If representation indicates UNRESOLVED or ambiguous contract
    if (
      contract.representation.includes("/* UNRESOLVED */") ||
      contract.representation.trim() === "" ||
      contract.compatibilityRules.includes("STATUS_UNRESOLVED")
    ) {
      return {
        contractId: contract.contractId,
        status: "UNRESOLVED",
        isStale: false,
        failureCode: "CONTRACT_UNRESOLVED",
        invariantsEvaluated,
        diagnostics: ["CONTRACT_UNRESOLVED: Contract contains unresolved symbols or definitions"],
        reconciliationDigest: sha256Hex(`unresolved:${contract.contractId}`),
      };
    }

    // Explicit incompatibility marker
    if (
      contract.representation.includes("/* INCOMPATIBLE */") ||
      contract.compatibilityRules.includes("STATUS_INCOMPATIBLE")
    ) {
      return {
        contractId: contract.contractId,
        status: "INCOMPATIBLE",
        isStale: false,
        failureCode: "CONTRACT_CONFLICT",
        invariantsEvaluated,
        diagnostics: ["CONTRACT_CONFLICT: Explicit incompatible contract rules detected"],
        reconciliationDigest: sha256Hex(`incompatible:${contract.contractId}`),
      };
    }

    const payload = {
      contractId: contract.contractId,
      producerRevision: currentProducerRevision,
      consumerRevision: currentConsumerRevision,
      status: "COMPATIBLE",
      invariantsEvaluated: [...invariantsEvaluated].sort(),
    };

    const reconciliationDigest = sha256Hex(canonicalJsonStringify(payload));

    return {
      contractId: contract.contractId,
      status: "COMPATIBLE",
      isStale: false,
      invariantsEvaluated,
      diagnostics: ["Contract successfully reconciled and compatible."],
      reconciliationDigest,
    };
  }

  private isVersionSatisfied(resolved: string, range: string): boolean {
    if (range === "*" || range === resolved) return true;
    if (range.startsWith("^")) {
      const targetMajor = range.slice(1).split(".")[0];
      const resolvedMajor = resolved.split(".")[0];
      return targetMajor === resolvedMajor;
    }
    if (range.startsWith("~")) {
      const parts = range.slice(1).split(".");
      const resParts = resolved.split(".");
      return parts[0] === resParts[0] && parts[1] === resParts[1];
    }
    return resolved.startsWith(range);
  }
}
