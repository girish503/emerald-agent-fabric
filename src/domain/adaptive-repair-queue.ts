/**
 * Phase 82 — Adaptive Dynamic Queue Scheduling and Cost-Aware Repair Orchestration
 *
 * Domain types and interfaces for the governed repair queue:
 * - Queue item data model and canonical hashing
 * - Structural complexity profile
 * - Cost estimates (verification, execution, human)
 * - Resource budgets and queue limits
 * - Scheduling decisions and audit metadata
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

export type ReviewTier =
  | "DIRECT_EXECUTION"
  | "SINGLE_REVIEWER"
  | "PANEL_REVIEW"
  | "HUMAN_COORDINATED";

export type QueueRiskClass = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type QueuePriorityClass =
  | "BACKGROUND"
  | "STANDARD"
  | "HIGH_PRIORITY"
  | "EXPEDITED";

export type SchedulingStrategy =
  | "FIFO"
  | "COMPLEXITY_FIRST"
  | "COST_FIRST"
  | "ADAPTIVE_COST_AWARE";

export interface ComplexityProfile {
  readonly filesTouched: number;
  readonly astNodesTouched: number;
  readonly functionsTouched: number;
  readonly modulesTouched: number;
  readonly dependencyEdges: number;
  readonly crossModuleEdges: number;
  readonly testCount: number;
  readonly expectedVerificationCommands: number;
  readonly expectedCleanRoomCost: number;
  readonly mutationCount: number;
  readonly reviewTier: ReviewTier;
  readonly profileDigest: string;
}

export interface RepairQueueItem {
  readonly queueItemId: string;
  readonly workflowId: string;
  readonly taskId: string;
  readonly sourceRevision: string;
  readonly proposalDigest: string;
  readonly structuralComplexity: ComplexityProfile;
  readonly estimatedVerificationCost: number;
  readonly estimatedExecutionCost: number;
  readonly estimatedHumanCost: number;
  readonly reviewTier: ReviewTier;
  readonly riskClass: QueueRiskClass;
  readonly enqueueTimestamp: string;
  readonly enqueueSequence: number;
  readonly agingFactor: number;
  readonly retryCount: number;
  readonly revisionCount: number;
  readonly priorityClass: QueuePriorityClass;
  readonly schedulingScore?: number;
  readonly isStarved?: boolean;
  readonly schedulingMetadataDigest: string;
}

export interface QueueResourceBudget {
  readonly maxActiveWorkflows: number;
  readonly maxActiveExecutions: number;
  readonly maxActiveVerifications: number;
  readonly maxActiveModelCalls: number;
  readonly maxMemoryBytes: number;
  readonly maxCpuTimeMs: number;
  readonly maxQueueDepth: number;
}

export interface QueueResourceUsage {
  readonly activeWorkflows: number;
  readonly activeExecutions: number;
  readonly activeVerifications: number;
  readonly activeModelCalls: number;
  readonly currentMemoryBytes: number;
  readonly currentCpuTimeMs: number;
  readonly queueDepth: number;
}

export interface QueueLimits {
  readonly MAX_ACTIVE_WORKFLOWS: number;
  readonly MAX_ACTIVE_EXECUTIONS: number;
  readonly MAX_ACTIVE_VERIFICATIONS: number;
  readonly MAX_ACTIVE_MODEL_CALLS: number;
  readonly MAX_MEMORY_BYTES: number;
  readonly MAX_CPU_TIME_MS: number;
  readonly MAX_QUEUE_DEPTH: number;
  readonly MAX_STARVATION_AGE_MS: number;
  readonly AGING_COEFFICIENT: number;
  readonly MAX_AGING_FACTOR: number;
}

export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
  MAX_ACTIVE_WORKFLOWS: 4,
  MAX_ACTIVE_EXECUTIONS: 2,
  MAX_ACTIVE_VERIFICATIONS: 2,
  MAX_ACTIVE_MODEL_CALLS: 4,
  MAX_MEMORY_BYTES: 4 * 1024 * 1024 * 1024, // 4 GiB
  MAX_CPU_TIME_MS: 300000, // 5 min
  MAX_QUEUE_DEPTH: 32,
  MAX_STARVATION_AGE_MS: 300000, // 5 min
  AGING_COEFFICIENT: 0.05,
  MAX_AGING_FACTOR: 5.0,
};

export interface SchedulingDecision {
  readonly decisionId: string;
  readonly strategy: SchedulingStrategy;
  readonly timestamp: string;
  readonly scheduledItemId: string;
  readonly scheduledWorkflowId: string;
  readonly candidateOrder: readonly string[];
  readonly scores: Record<string, number>;
  readonly starvationGuardsTriggered: readonly string[];
  readonly resourceUsage: QueueResourceUsage;
  readonly fencingChecksPassed: boolean;
  readonly decisionDigest: string;
}

export function computeComplexityDigest(
  profile: Omit<ComplexityProfile, "profileDigest">
): string {
  const normalized = {
    filesTouched: profile.filesTouched,
    astNodesTouched: profile.astNodesTouched,
    functionsTouched: profile.functionsTouched,
    modulesTouched: profile.modulesTouched,
    dependencyEdges: profile.dependencyEdges,
    crossModuleEdges: profile.crossModuleEdges,
    testCount: profile.testCount,
    expectedVerificationCommands: profile.expectedVerificationCommands,
    expectedCleanRoomCost: profile.expectedCleanRoomCost,
    mutationCount: profile.mutationCount,
    reviewTier: profile.reviewTier,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function computeQueueItemDigest(
  item: Omit<RepairQueueItem, "schedulingMetadataDigest" | "schedulingScore">
): string {
  const normalized = {
    queueItemId: item.queueItemId,
    workflowId: item.workflowId,
    taskId: item.taskId,
    sourceRevision: item.sourceRevision,
    proposalDigest: item.proposalDigest,
    complexityDigest: item.structuralComplexity.profileDigest,
    estimatedVerificationCost: item.estimatedVerificationCost,
    estimatedExecutionCost: item.estimatedExecutionCost,
    estimatedHumanCost: item.estimatedHumanCost,
    reviewTier: item.reviewTier,
    riskClass: item.riskClass,
    enqueueTimestamp: item.enqueueTimestamp,
    enqueueSequence: item.enqueueSequence,
    retryCount: item.retryCount,
    revisionCount: item.revisionCount,
    priorityClass: item.priorityClass,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function computeSchedulingDecisionDigest(
  decision: Omit<SchedulingDecision, "decisionDigest">
): string {
  const normalized = {
    decisionId: decision.decisionId,
    strategy: decision.strategy,
    timestamp: decision.timestamp,
    scheduledItemId: decision.scheduledItemId,
    scheduledWorkflowId: decision.scheduledWorkflowId,
    candidateOrder: decision.candidateOrder,
    scores: decision.scores,
    starvationGuardsTriggered: decision.starvationGuardsTriggered,
    resourceUsage: decision.resourceUsage,
    fencingChecksPassed: decision.fencingChecksPassed,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}
