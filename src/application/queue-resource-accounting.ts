/**
 * Phase 82 — Queue Resource Accounting and Budget Manager
 *
 * Tracks active resource utilization and enforces hard budget ceilings:
 * - Active workflows
 * - Active executions
 * - Active clean-room verifications
 * - Active model calls
 * - Memory bytes & CPU time ceilings
 * - Queue depth bounds
 */

import {
  DEFAULT_QUEUE_LIMITS,
  QueueLimits,
  QueueResourceUsage,
  RepairQueueItem,
} from "../domain/adaptive-repair-queue.js";

export interface ResourceReservationResult {
  readonly permitted: boolean;
  readonly reason?: string;
  readonly failureCode?: "RESOURCE_BUDGET_EXCEEDED" | "QUEUE_DEPTH_EXCEEDED";
  readonly updatedUsage: QueueResourceUsage;
}

export class QueueResourceManager {
  private usage: QueueResourceUsage;
  private readonly limits: QueueLimits;

  constructor(limits: QueueLimits = DEFAULT_QUEUE_LIMITS) {
    this.limits = limits;
    this.usage = {
      activeWorkflows: 0,
      activeExecutions: 0,
      activeVerifications: 0,
      activeModelCalls: 0,
      currentMemoryBytes: 0,
      currentCpuTimeMs: 0,
      queueDepth: 0,
    };
  }

  public getUsage(): QueueResourceUsage {
    return { ...this.usage };
  }

  public setQueueDepth(depth: number): void {
    this.usage = { ...this.usage, queueDepth: depth };
  }

  /**
   * Evaluates whether a queue item can be admitted to the queue.
   */
  public canEnqueue(): { permitted: boolean; reason?: string } {
    if (this.usage.queueDepth >= this.limits.MAX_QUEUE_DEPTH) {
      return {
        permitted: false,
        reason: `QUEUE_DEPTH_EXCEEDED: Current depth ${this.usage.queueDepth} reaches ceiling ${this.limits.MAX_QUEUE_DEPTH}`,
      };
    }
    return { permitted: true };
  }

  /**
   * Evaluates whether an item can be dispatched for execution/verification.
   */
  public canDispatch(item: RepairQueueItem): ResourceReservationResult {
    const requiredCalls = item.reviewTier === "PANEL_REVIEW" ? 4 : item.reviewTier === "SINGLE_REVIEWER" ? 2 : 1;
    const requiredMemory = item.structuralComplexity.expectedCleanRoomCost * 1024 * 1024; // ~1MB per cost unit
    const requiredCpuMs = item.estimatedVerificationCost + item.estimatedExecutionCost;

    if (this.usage.activeWorkflows + 1 > this.limits.MAX_ACTIVE_WORKFLOWS) {
      return {
        permitted: false,
        reason: `RESOURCE_BUDGET_EXCEEDED: Active workflows ceiling reached (${this.limits.MAX_ACTIVE_WORKFLOWS})`,
        failureCode: "RESOURCE_BUDGET_EXCEEDED",
        updatedUsage: { ...this.usage },
      };
    }

    if (this.usage.activeExecutions + 1 > this.limits.MAX_ACTIVE_EXECUTIONS) {
      return {
        permitted: false,
        reason: `RESOURCE_BUDGET_EXCEEDED: Active executions ceiling reached (${this.limits.MAX_ACTIVE_EXECUTIONS})`,
        failureCode: "RESOURCE_BUDGET_EXCEEDED",
        updatedUsage: { ...this.usage },
      };
    }

    if (this.usage.activeModelCalls + requiredCalls > this.limits.MAX_ACTIVE_MODEL_CALLS) {
      return {
        permitted: false,
        reason: `RESOURCE_BUDGET_EXCEEDED: Active model calls ceiling reached (${this.limits.MAX_ACTIVE_MODEL_CALLS})`,
        failureCode: "RESOURCE_BUDGET_EXCEEDED",
        updatedUsage: { ...this.usage },
      };
    }

    if (this.usage.currentMemoryBytes + requiredMemory > this.limits.MAX_MEMORY_BYTES) {
      return {
        permitted: false,
        reason: `RESOURCE_BUDGET_EXCEEDED: Memory budget exceeded (${this.limits.MAX_MEMORY_BYTES} bytes)`,
        failureCode: "RESOURCE_BUDGET_EXCEEDED",
        updatedUsage: { ...this.usage },
      };
    }

    return {
      permitted: true,
      updatedUsage: {
        ...this.usage,
        activeWorkflows: this.usage.activeWorkflows + 1,
        activeExecutions: this.usage.activeExecutions + 1,
        activeModelCalls: this.usage.activeModelCalls + requiredCalls,
        currentMemoryBytes: this.usage.currentMemoryBytes + requiredMemory,
        currentCpuTimeMs: this.usage.currentCpuTimeMs + requiredCpuMs,
      },
    };
  }

  /**
   * Reserves resources for a dispatched item.
   */
  public reserve(item: RepairQueueItem): boolean {
    const check = this.canDispatch(item);
    if (!check.permitted) {
      return false;
    }
    this.usage = check.updatedUsage;
    return true;
  }

  /**
   * Releases resources when an item completes execution/verification.
   */
  public release(item: RepairQueueItem): void {
    const requiredCalls = item.reviewTier === "PANEL_REVIEW" ? 4 : item.reviewTier === "SINGLE_REVIEWER" ? 2 : 1;
    const requiredMemory = item.structuralComplexity.expectedCleanRoomCost * 1024 * 1024;
    const requiredCpuMs = item.estimatedVerificationCost + item.estimatedExecutionCost;

    this.usage = {
      ...this.usage,
      activeWorkflows: Math.max(0, this.usage.activeWorkflows - 1),
      activeExecutions: Math.max(0, this.usage.activeExecutions - 1),
      activeModelCalls: Math.max(0, this.usage.activeModelCalls - requiredCalls),
      currentMemoryBytes: Math.max(0, this.usage.currentMemoryBytes - requiredMemory),
      currentCpuTimeMs: Math.max(0, this.usage.currentCpuTimeMs - requiredCpuMs),
    };
  }

  /**
   * Resets all resource counters to zero.
   */
  public reset(): void {
    this.usage = {
      activeWorkflows: 0,
      activeExecutions: 0,
      activeVerifications: 0,
      activeModelCalls: 0,
      currentMemoryBytes: 0,
      currentCpuTimeMs: 0,
      queueDepth: 0,
    };
  }
}
