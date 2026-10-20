/**
 * Phase 83 — Automated Delta Test Suite Minimization and Predictive Clean-Room Verification
 *
 * Domain types and models for structural impact analysis, test-to-code mapping,
 * predictive delta verification, and safety invariants.
 *
 * CORE SAFETY PRINCIPLE:
 * "Predictive verification may save time. Only independent full verification may establish truth."
 * Delta verification is strictly screening / predictive metadata.
 * It is NEVER authoritative (authoritative === false permanently).
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

export type ImpactNodeType = "FILE" | "SYMBOL" | "TEST" | "MODULE";

export type ImpactEdgeType =
  | "IMPORTS"
  | "CALLS"
  | "DEFINES"
  | "TESTS"
  | "DEPENDS_ON";

export type MissClassification =
  | "DIRECT_IMPACT_MISSED"
  | "TRANSITIVE_DEPENDENCY_MISSED"
  | "CROSS_MODULE_IMPACT_MISSED"
  | "CONFIGURATION_IMPACT_MISSED"
  | "STATE_DEPENDENCY_MISSED"
  | "TEST_MAPPING_UNKNOWN"
  | "ANALYSIS_LIMIT"
  | "UNKNOWN_IMPACT";

export type DeltaSelectionMethod =
  | "FULL_SUITE"
  | "DIRECT_AST_IMPACT"
  | "DEPENDENCY_CLOSURE"
  | "RISK_AWARE_DELTA";

export interface ImpactNode {
  readonly id: string;
  readonly type: ImpactNodeType;
  readonly name: string;
  readonly path: string;
}

export interface ImpactEdge {
  readonly source: string;
  readonly target: string;
  readonly type: ImpactEdgeType;
  readonly weight: number;
}

export interface ImpactGraph {
  readonly graphId: string;
  readonly nodes: readonly ImpactNode[];
  readonly edges: readonly ImpactEdge[];
  readonly sourceRevision: string;
  readonly graphDigest: string;
}

export interface DeltaTestCandidate {
  readonly testId: string;
  readonly testPath: string;
  readonly testCommand: string;
  readonly sourceRevision: string;
  readonly affectedFiles: readonly string[];
  readonly affectedSymbols: readonly string[];
  readonly dependencyDistance: number;
  readonly selectionReason: string;
  readonly selectionScore: number;
  readonly provenanceDigest: string;
}

export interface DeltaTestSuite {
  readonly suiteId: string;
  readonly runId: string;
  readonly sourceRevision: string;
  readonly patchDigest: string;
  readonly selectedTests: readonly DeltaTestCandidate[];
  readonly excludedTests: readonly DeltaTestCandidate[];
  readonly selectionMethod: DeltaSelectionMethod;
  readonly impactGraphDigest: string;
  readonly selectionDigest: string;
}

export interface DeltaVerificationResult {
  readonly status: "PREDICTIVE_PASS" | "PREDICTED_VERIFICATION_FAILURE" | "ANALYSIS_ERROR";
  readonly executedTests: readonly string[];
  readonly passedTests: readonly string[];
  readonly failedTests: readonly string[];
  readonly durationMs: number;
  readonly detectionClass:
    | "EARLY_DEFECT_DETECTED"
    | "PREDICTIVE_PASS_CLEAN"
    | "PREDICTIVE_FALSE_NEGATIVE"
    | "NONE";
  readonly fullSuiteRequired: true;
  readonly authoritative: false;
}

export function computeImpactGraphDigest(
  graph: Omit<ImpactGraph, "graphDigest">
): string {
  const normalized = {
    graphId: graph.graphId,
    nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, path: n.path })),
    edges: graph.edges.map((e) => ({ source: e.source, target: e.target, type: e.type, weight: e.weight })),
    sourceRevision: graph.sourceRevision,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function computeDeltaCandidateDigest(
  candidate: Omit<DeltaTestCandidate, "provenanceDigest">
): string {
  const normalized = {
    testId: candidate.testId,
    testPath: candidate.testPath,
    testCommand: candidate.testCommand,
    sourceRevision: candidate.sourceRevision,
    affectedFiles: candidate.affectedFiles,
    affectedSymbols: candidate.affectedSymbols,
    dependencyDistance: candidate.dependencyDistance,
    selectionReason: candidate.selectionReason,
    selectionScore: candidate.selectionScore,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function computeDeltaTestSuiteDigest(
  suite: Omit<DeltaTestSuite, "selectionDigest">
): string {
  const normalized = {
    suiteId: suite.suiteId,
    runId: suite.runId,
    sourceRevision: suite.sourceRevision,
    patchDigest: suite.patchDigest,
    selectedTests: suite.selectedTests.map((t) => t.testId),
    excludedTests: suite.excludedTests.map((t) => t.testId),
    selectionMethod: suite.selectionMethod,
    impactGraphDigest: suite.impactGraphDigest,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}
