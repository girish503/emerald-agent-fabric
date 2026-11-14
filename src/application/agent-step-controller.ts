/**
 * Governed Autonomous Agent Step Controller for Emerald Agent Fabric.
 *
 * Implements the bounded autonomous reasoning loop connecting:
 * Context Engine
 *     ↓
 * AgentBrainPort (untrusted reasoning)
 *     ↓
 * ActionProposal
 *     ↓
 * ProposalValidator (11-stage governance check)
 *     ↓
 * Action aggregate (authoritative domain intent)
 *     ↓
 * WorkerRuntime (governed lifecycle execution)
 *     ↓
 * Observation updates & loop control
 *
 * Architectural Invariants:
 * 1. Strictly Bounded: Controlled by finite budgets (maxSteps, maxWallClockMs, maxActions, maxConsecutiveFailures, maxProposalRejections).
 * 2. Authority Separation: StepController is an orchestrator. It does not validate schemas, authorize capabilities, or execute tools directly.
 * 3. Zero Direct Provider Calls: providerInvocationCount === 0 for StepController itself.
 * 4. Serial Action Invariant: At most one active Action per Run at any time.
 * 5. UNKNOWN Safety Stop: Halts immediately if execution uncertainty (UNKNOWN) occurs.
 * 6. Lease & Contract Governance: Enforces active lease fencing and active Mission Contract integrity before each step.
 * 7. Cancellable: Respects AbortSignal before and during execution steps without mutating terminal domain state unlawfully.
 * 8. Zero Persistence Mutation: Never bypasses domain or state store boundaries; introduces zero new database tables.
 */

import {
  ContextBudget,
  ContextSnapshot,
  Observation,
  computeObservationContentHash,
  estimateBytes,
  estimateTokens,
  validateObservation,
} from "../domain/context.js";
import { redactSensitiveData, computeCanonicalHash, canonicalJsonStringify } from "../domain/canonical-hash.js";
import {
  ContextBudgetExceededError,
  LeaseExpiredError,
  LeaseLostError,
  ModelProviderError,
  ModelRequestTimeoutError,
  ModelRequestCancelledError,
  ModelProviderUnavailableError,
  ModelResponseInvalidError,
} from "../domain/errors.js";
import {
  type ModelInferenceOutcome,
  type ModelInferenceTelemetryEvent,
  type ModelInferenceTelemetryPayload,
} from "../domain/events.js";
import { ProposalRejectionReason } from "../domain/action-proposal.js";
import { defaultGovernedToolRegistry, ExtendedToolName, ToolName, type ToolDefinition } from "../domain/tool.js";
import {
  createOutputPayloadEvidence,
  createProcessExitEvidence,
  type Evidence,
} from "../domain/evidence.js";
import {
  DeterministicVerifier,
  type VerificationResult,
  type CleanRoomVerificationSpec,
} from "../domain/verification.js";
import type { CleanRoomVerificationOutcome, CleanRoomVerifier } from "./clean-room-verifier.js";
import type { MissionContract } from "../domain/mission-contract.js";
import type { RunCommandOutput } from "../domain/tool-schemas.js";
import {
  computeReflexContextHash,
  validateReflexDecision,
  type ReflexContext,
  type ReflexDecisionKind,
  type ReflexReasonCode,
} from "../domain/reflex.js";
import {
  createReflexEvidence,
  type ReflexEvidence,
} from "../domain/reflex-evidence.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { type LeaseFencingCheck, StateStorePort } from "../ports/state-store.port.js";
import { ToolRegistryPort } from "../ports/tool-registry.port.js";
import { ContextSourcePort } from "../ports/context-source.port.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
  BrainFinishReason,
} from "../ports/agent-brain.port.js";
import type { ReflexPort } from "../ports/reflex.port.js";
import { NoopReflex } from "../adapters/reflex/noop-reflex.js";
import { RunCoordinator } from "./run-coordinator.js";
import {
  REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT,
  WorkerActionResult,
  WorkerActionStatus,
  WorkerRuntime,
  extractReplayBlockDetails,
} from "./worker-runtime.js";
import { ProposalValidator } from "./proposal-validator.js";
import { ContextSource } from "./context/context-source.js";
import { ContextEngine } from "./context/context-engine.js";
import { ContextResidencyTracker } from "./context-residency-tracker.js";
import * as fsSync from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import { LineAnchoredEditor } from "../production/repair/line-anchored-editor.js";
import { FailedAnchorTracker } from "./failed-anchor-tracker.js";
import {
  DuplicateProposalDetector,
  isOversizedWholeFileAnchor,
} from "./duplicate-proposal-detector.js";
import {
  PostPassVerificationLatch,
  type PostPassLatchSnapshot,
} from "./post-pass-verification-latch.js";
import {
  saveStepLoopCheckpoint,
  reconcileCheckpointWithDurableEvidence,
} from "./step-loop-checkpoint.js";
import {
  ProgressLoopDetector,
  type ProgressAssessment,
  DEFAULT_MAX_CONSECUTIVE_CYCLE_REPETITIONS,
  DEFAULT_MAX_CYCLE_LENGTH,
} from "./progress-loop-detector.js";
export {
  DEFAULT_MAX_CONSECUTIVE_CYCLE_REPETITIONS,
  DEFAULT_MAX_CYCLE_LENGTH,
} from "./progress-loop-detector.js";
import type { MissionCheckpoint } from "../ports/state-store.port.js";
import type { AttemptSnapshot } from "../domain/attempt.js";
import { ScopedContextMemoryService } from "./scoped-context-memory.js";
import {
  BoundedRepairLoopController,
  type RepairCycleState,
} from "./bounded-repair-loop.js";
import { ProductionVerifier } from "../verification/production-verifier.js";
import type { EmeraldLifecycleTelemetry } from "./observability-instrumentation.js";

// ============================================================================
// 1. Budgets & Defaults
// ============================================================================

export interface StepControllerBudget {
  /** Maximum reasoning iterations allowed in this execution loop */
  readonly maxSteps: number;
  /** Maximum elapsed wall-clock milliseconds before the loop must terminate */
  readonly maxWallClockMs: number;
  /** Maximum number of logical Actions allowed to be executed */
  readonly maxActions: number;
  /** Maximum consecutive action execution failures before halting */
  readonly maxConsecutiveFailures: number;
  /** Maximum cumulative proposal validation rejections before halting */
  readonly maxProposalRejections: number;
  /** Maximum consecutive identical successful read actions producing no state change before halting */
  readonly maxConsecutiveIdenticalReads?: number;
  /** Maximum consecutive identical successful write_file actions (same path and content) before halting */
  readonly maxConsecutiveIdenticalWrites?: number;
  /** Maximum consecutive ineffective edits failing to pass tests before halting */
  readonly maxConsecutiveIneffectiveEdits?: number;
  /** Maximum consecutive ineffective multi-step cycle repetitions before halting (default: 2) */
  readonly maxConsecutiveCycleRepetitions?: number;
  /** Maximum cycle length L to evaluate (default: 5) */
  readonly maxCycleLength?: number;
  /** Whether generalized multi-step loop progress detection is enabled (default: true) */
  readonly enableProgressLoopDetection?: boolean;
  /** Whether intermediate test feedback after mutations is enabled */
  readonly enableIntermediateTestFeedback?: boolean;
  /** Whether the post-pass verification latch is enabled */
  readonly enablePostPassVerificationLatch?: boolean;
  /** Whether durable checkpointing at safe boundaries is enabled */
  readonly enableCheckpointing?: boolean;
  /** Maximum number of system-owned verification actions allowed across the run (default: 5) */
  readonly maxVerificationActions?: number;
  /** Maximum elapsed wall-clock milliseconds allowed specifically for verification stage execution (default: 60_000) */
  readonly maxVerificationWallClockMs?: number;
}

export const DEFAULT_MAX_CONSECUTIVE_IDENTICAL_READS = 3;
export const DEFAULT_MAX_CONSECUTIVE_IDENTICAL_WRITES = 3;
export const DEFAULT_MAX_CONSECUTIVE_INEFFECTIVE_EDITS = 3;
export const DEFAULT_MAX_VERIFICATION_ACTIONS = 5;
export const DEFAULT_MAX_VERIFICATION_WALL_CLOCK_MS = 60_000;

export const DEFAULT_STEP_CONTROLLER_BUDGET: StepControllerBudget = Object.freeze({
  maxSteps: 10,
  maxWallClockMs: 60_000,
  maxActions: 10,
  maxConsecutiveFailures: 3,
  maxProposalRejections: 3,
  maxConsecutiveIdenticalReads: DEFAULT_MAX_CONSECUTIVE_IDENTICAL_READS,
  maxConsecutiveIdenticalWrites: DEFAULT_MAX_CONSECUTIVE_IDENTICAL_WRITES,
  maxConsecutiveIneffectiveEdits: DEFAULT_MAX_CONSECUTIVE_INEFFECTIVE_EDITS,
  maxConsecutiveCycleRepetitions: DEFAULT_MAX_CONSECUTIVE_CYCLE_REPETITIONS,
  maxCycleLength: DEFAULT_MAX_CYCLE_LENGTH,
  enableProgressLoopDetection: true,
  enableIntermediateTestFeedback: true,
  enablePostPassVerificationLatch: true,
  enableCheckpointing: true,
  maxVerificationActions: DEFAULT_MAX_VERIFICATION_ACTIONS,
  maxVerificationWallClockMs: DEFAULT_MAX_VERIFICATION_WALL_CLOCK_MS,
});

export const MAX_REJECTION_FEEDBACK_CHARS = 512;
export const REPEATED_IDENTICAL_READ_ADVISORY_THRESHOLD = 2;
export const REPEATED_IDENTICAL_WRITE_ADVISORY_THRESHOLD = 2;

/**
 * Deterministic mapping of known model hallucination aliases to authoritative schema parameter names.
 * Scoped strictly to registered tool schemas (ADR-0029 / src/domain/tool-schemas.ts).
 */
export const DETERMINISTIC_TOOL_PARAMETER_MAPPINGS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = Object.freeze({
  read_file: Object.freeze({
    filePath: "path",
    file_path: "path",
    filepath: "path",
    filename: "path",
    file: "path",
  }),
  write_file: Object.freeze({
    filePath: "path",
    file_path: "path",
    filepath: "path",
    filename: "path",
    file: "path",
    text: "content",
    data: "content",
  }),
  edit_file: Object.freeze({
    filePath: "path",
    file_path: "path",
    filepath: "path",
    filename: "path",
    file: "path",
    oldText: "searchAnchor",
    old_text: "searchAnchor",
    target: "searchAnchor",
    anchor: "searchAnchor",
    search_anchor: "searchAnchor",
    newText: "replacementText",
    new_text: "replacementText",
    replacement: "replacementText",
    replacement_text: "replacementText",
    content: "replacementText",
  }),
  search_code: Object.freeze({
    pattern: "query",
    search_term: "query",
    searchTerm: "query",
    filePaths: "path",
    files: "path",
  }),
});

/**
 * Derives actionable validation guidance for supported schema validation failures.
 * Returns null if the failure cannot be safely converted into actionable guidance,
 * ensuring unknown or unrelated errors retain sanitized fallback feedback without fabrication.
 */
export function deriveActionableValidationGuidance(options: {
  readonly toolName?: string;
  readonly rejectionReason?: ProposalRejectionReason | string;
  readonly inputPayload?: unknown;
  readonly validatorMessage?: string;
}): string | null {
  if (options.rejectionReason === "DISALLOWED_FILE_OVERWRITE") {
    return "Direct overwrite of existing files via 'write_file' is disallowed under governed benchmark repair policy. Use 'edit_file' with exact searchAnchor targeting (using exact literal code text, NOT line numbers like 'line:10') to make localized modifications, or set allowWholeFileReplacement=true if full replacement is authorized.";
  }
  if (options.rejectionReason === "NOOP_EDIT_DISALLOWED") {
    const payload = options.inputPayload as Record<string, unknown> | null;
    const searchAnchor =
      typeof payload?.searchAnchor === "string" ? payload.searchAnchor : undefined;
    if (searchAnchor !== undefined && isOversizedWholeFileAnchor(searchAnchor)) {
      return (
        "edit_file proposal rejected: The entire source file (or an oversized multi-declaration block) was submitted as both 'searchAnchor' and 'replacementText'. " +
        "Do NOT submit the whole file. 'searchAnchor' must contain ONLY a small, exact literal source fragment (1-3 lines) around the intended change. " +
        "'replacementText' must be different and provide ONLY the corrected fragment. The rest of the file remains untouched automatically. " +
        "Generic example: searchAnchor: \"const discount = rate * 0.1;\", replacementText: \"const discount = rate * 0.15;\"."
      );
    }
    return "edit_file proposal rejected: 'searchAnchor' and 'replacementText' are identical. A localized edit must specify a different 'replacementText' that modifies the target file. Choose a small, unique literal code anchor around the bug and provide the corrected replacement.";
  }
  if (options.rejectionReason === "REPEATED_FAILED_ANCHOR_DISALLOWED") {
    return "edit_file proposal rejected: The searchAnchor has already failed for this file and no fresh read has occurred. Re-read the target file with 'read_file' to inspect the actual source code and choose a verified literal anchor.";
  }
  if (options.rejectionReason === "WHOLE_FILE_ANCHOR_DISALLOWED") {
    return (
      "edit_file proposal rejected: The searchAnchor spans the entire file content. " +
      "Governed benchmark repair requires localized edits (1-3 lines around the defect). " +
      "Choose an exact snippet from the file containing only the specific lines needing modification. " +
      "Do NOT submit the whole file as the searchAnchor."
    );
  }
  if (options.rejectionReason === "DUPLICATE_PROPOSAL_DISALLOWED") {
    return "Proposal rejected: An identical tool proposal was already rejected in the immediately preceding turn without any intervening actions or state changes. Repeating the identical proposal is disallowed. You must propose a meaningfully different action (e.g. read the file, search code, or use a distinct localized anchor and replacement).";
  }
  if (options.rejectionReason === "POST_VERIFICATION_MUTATION_DISALLOWED") {
    return "Proposal rejected: Target file has already passed verification tests and is locked by the post-pass verification latch. Do NOT modify already-passing code. Propose verification tests or conclude the task with isGoalReached: true.";
  }
  if (options.rejectionReason === "INEFFECTIVE_MUTATION_DISALLOWED") {
    return "edit_file proposal rejected: An identical mutation was already executed and failed intermediate verification, and the target file state has not changed. Do not repeat failed edits. Re-read the file with 'read_file' to inspect the actual source code and verification failure output, and propose a materially different localized edit.";
  }
  if (options.rejectionReason !== "INVALID_TOOL_INPUT") {
    return null;
  }
  const toolName = options.toolName;
  if (!toolName || !(toolName in DETERMINISTIC_TOOL_PARAMETER_MAPPINGS)) {
    return null;
  }
  const toolMappings = DETERMINISTIC_TOOL_PARAMETER_MAPPINGS[toolName];
  if (!toolMappings) {
    return null;
  }

  // 1. Inspect inputPayload keys if provided as a record
  if (
    options.inputPayload &&
    typeof options.inputPayload === "object" &&
    !Array.isArray(options.inputPayload)
  ) {
    const payloadKeys = Object.keys(options.inputPayload as Record<string, unknown>);
    for (const key of payloadKeys) {
      if (key in toolMappings) {
        const expectedField = toolMappings[key];
        return `Invalid ${toolName} input: unrecognized key "${key}"; expected field "${expectedField}". Retry using "${expectedField}" and the documented ${toolName} schema.`;
      }
    }
  }

  // 2. Inspect validatorMessage for referenced unrecognized keys matching known aliases
  if (options.validatorMessage && typeof options.validatorMessage === "string") {
    for (const [aliasKey, expectedField] of Object.entries(toolMappings)) {
      if (
        options.validatorMessage.includes(`'${aliasKey}'`) ||
        options.validatorMessage.includes(`"${aliasKey}"`)
      ) {
        return `Invalid ${toolName} input: unrecognized key "${aliasKey}"; expected field "${expectedField}". Retry using "${expectedField}" and the documented ${toolName} schema.`;
      }
    }
  }

  return null;
}

/**
 * Sanitizes proposal rejection feedback strings against credentials and private keys:
 * - PEM private key blocks
 * - Authorization Bearer tokens
 * - Common key/secret/token patterns
 */
export function sanitizeRejectionMessage(text: string): string {
  if (typeof text !== "string") {
    return "";
  }
  let result = text.replace(
    /-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]+PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]"
  );
  result = result.replace(/Bearer\s+[A-Za-z0-9\-_.]+/gi, "Bearer [REDACTED]");
  result = result.replace(
    /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9\-_./+=]{8,}["']?/gi,
    (match) => {
      const parts = match.split(/[:=]/);
      return `${parts[0]}: "[REDACTED]"`;
    }
  );
  return result;
}

// ============================================================================
// 1b. Verification Recovery Guidance & Assertion Parsing
// ============================================================================

export interface ParsedAssertionEvidence {
  readonly assertionKind: string;
  readonly actualValue?: string;
  readonly expectedValue?: string;
  readonly testFile?: string;
  readonly testLine?: number;
  readonly failingExpression?: string;
  readonly matchedSourceStatement?: string;
}

export interface VerificationRecoveryAnalysis {
  readonly assertionKind: string;
  readonly actualValue?: string;
  readonly expectedValue?: string;
  readonly testFile?: string;
  readonly testLine?: number;
  readonly failingExpression?: string;
  readonly targetRelPath?: string;
  readonly matchedSourceStatement?: string;
  readonly recoveryAdvisory: string;
}

/**
 * Safely parses assertion failure evidence from test stderr/stdout.
 * Extracts actual vs expected values, test file location, invocation expression,
 * and matches relevant statements in the target source without hardcoding benchmark tasks.
 * Returns null if the failure cannot be safely parsed as an assertion failure.
 */
export function parseAssertionEvidence(params: {
  readonly stderr?: string;
  readonly stdout?: string;
  readonly workspaceHostPath?: string;
  readonly targetRelPath?: string;
  readonly currentSourceContext?: string;
}): ParsedAssertionEvidence | null {
  const stderr = params.stderr || "";
  const stdout = params.stdout || "";
  const combined = `${stderr}\n${stdout}`;

  if (!combined.trim()) {
    return null;
  }

  // 1. Determine assertion kind and extract actual/expected values
  let assertionKind: string | undefined;
  let actualValue: string | undefined;
  let expectedValue: string | undefined;

  // Pattern 1: Node assert diff (e.g. "undefined !== [ 255, 255, 255 ]" or "6 !== 5")
  const nodeDiffMatch = combined.match(
    /(?:Expected values to be strictly (?:deep-)?equal:\s*)?([^\r\n]+?)\s*!==\s*([^\r\n]+)/
  );
  if (nodeDiffMatch && nodeDiffMatch[1] && nodeDiffMatch[2]) {
    actualValue = nodeDiffMatch[1].trim().slice(0, 120);
    expectedValue = nodeDiffMatch[2].trim().slice(0, 120);
    if (combined.includes("strictly deep-equal")) {
      assertionKind = "DEEP_EQUAL";
    } else if (combined.includes("strictly equal")) {
      assertionKind = "STRICT_EQUAL";
    } else {
      assertionKind = "DIFF_EQUAL";
    }
  }

  // Pattern 2: Jest/Vitest diff format
  if (!assertionKind) {
    const vitestExpectedMatch = combined.match(/- Expected\s*:\s*([^\r\n]+)/i);
    const vitestReceivedMatch = combined.match(/\+ Received\s*:\s*([^\r\n]+)/i);
    if (vitestExpectedMatch && vitestReceivedMatch && vitestExpectedMatch[1] && vitestReceivedMatch[1]) {
      expectedValue = vitestExpectedMatch[1].trim().slice(0, 120);
      actualValue = vitestReceivedMatch[1].trim().slice(0, 120);
      assertionKind = "DIFF_EQUAL";
    } else {
      const toBeMatch = combined.match(/expected\s+([^\r\n]+?)\s+to (?:be|equal)\s+([^\r\n]+)/i);
      if (toBeMatch && toBeMatch[1] && toBeMatch[2]) {
        actualValue = toBeMatch[1].trim().slice(0, 120);
        expectedValue = toBeMatch[2].trim().slice(0, 120);
        assertionKind = "STRICT_EQUAL";
      }
    }
  }

  // Pattern 3: Node assert.throws missing exception
  if (!assertionKind && (combined.includes("Missing expected exception") || combined.includes("Expected function to throw"))) {
    assertionKind = "THROWS";
  }

  // Pattern 4: Generic unhandled error or exception
  if (!assertionKind) {
    if (combined.includes("Error:") || combined.includes("AssertionError") || combined.includes("throw ")) {
      assertionKind = "ERROR";
    } else {
      return null;
    }
  }

  // 2. Extract test file and line from stack frames
  let testFile: string | undefined;
  let testLine: number | undefined;

  const stackRegex =
    /(?:at\s+(?:.+?\s+\()?|❯\s*)([a-zA-Z]:[\\\/][^\r\n:()]+|[\\\/][^\r\n:()]+|[a-zA-Z0-9_\-./\\]+\.(?:[cm]?[jt]sx?)):(\d+)(?::(\d+))?\)?/g;
  let stackMatch: RegExpExecArray | null;
  while ((stackMatch = stackRegex.exec(combined)) !== null) {
    const rawPath = stackMatch[1];
    const rawLineStr = stackMatch[2];
    if (!rawPath || !rawLineStr) continue;
    const rawLine = parseInt(rawLineStr, 10);

    // Skip node internals, node_modules, and tooling
    if (
      rawPath.includes("node:internal") ||
      rawPath.includes("node_modules") ||
      rawPath.includes("vitest/dist") ||
      rawPath.includes("jest-circus")
    ) {
      continue;
    }

    let relCandidate = rawPath;
    if (params.workspaceHostPath && path.isAbsolute(rawPath)) {
      try {
        const rel = path.relative(params.workspaceHostPath, rawPath);
        if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
          relCandidate = rel;
        }
      } catch {
        // Fall back to rawPath
      }
    }

    relCandidate = relCandidate.replace(/\\/g, "/");
    testFile = relCandidate;
    testLine = Number.isFinite(rawLine) ? rawLine : undefined;
    break;
  }

  // 3. Extract failing invocation expression from test file if accessible
  let failingExpression: string | undefined;
  if (testFile && testLine && params.workspaceHostPath) {
    try {
      const editor = new LineAnchoredEditor();
      const safeTestPath = editor.resolveSafePath(testFile, params.workspaceHostPath);
      if (fsSync.existsSync(safeTestPath)) {
        const testContent = fsSync.readFileSync(safeTestPath, "utf-8");
        const lines = testContent.split(/\r?\n/);
        if (testLine >= 1 && testLine <= lines.length) {
          const testCodeLine = (lines[testLine - 1] ?? "").trim();

          // Pattern A: assert.throws
          const throwsMatch = testCodeLine.match(
            /assert\.throws\(\s*(?:\(\)\s*=>\s*|\bfunction\s*\(\)\s*\{\s*(?:return\s*)?)?([\s\S]+?)\s*(?:\}\s*)?\);?$/
          );
          if (throwsMatch && throwsMatch[1]) {
            let expr = throwsMatch[1].trim();
            if (expr.endsWith(")") && (expr.match(/\(/g) || []).length < (expr.match(/\)/g) || []).length) {
              expr = expr.slice(0, -1).trim();
            }
            failingExpression = expr.slice(0, 120);
          }

          // Pattern B: expect(expr).to...
          if (!failingExpression) {
            const expectMatch = testCodeLine.match(/expect\(\s*([\s\S]+?)\s*\)\./);
            if (expectMatch && expectMatch[1]) {
              failingExpression = expectMatch[1].trim().slice(0, 120);
            }
          }

          // Pattern C: assert.equal/strictEqual/deepStrictEqual(arg1, arg2...)
          if (!failingExpression) {
            const assertMatch = testCodeLine.match(
              /assert\.(?:deepStrictEqual|strictEqual|equal|deepEqual|notStrictEqual|notDeepEqual)\(\s*/
            );
            if (assertMatch && assertMatch.index !== undefined) {
              const startIdx = assertMatch.index + assertMatch[0].length;
              let depthParen = 0;
              let depthBracket = 0;
              let depthBrace = 0;
              let inQuote: string | null = null;
              let arg1End = -1;

              for (let i = startIdx; i < testCodeLine.length; i++) {
                const char = testCodeLine[i];
                if (inQuote) {
                  if (char === inQuote && testCodeLine[i - 1] !== "\\") {
                    inQuote = null;
                  }
                  continue;
                }
                if (char === '"' || char === "'" || char === "`") {
                  inQuote = char;
                  continue;
                }
                if (char === "(") depthParen++;
                else if (char === ")") {
                  if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
                    arg1End = i;
                    break;
                  }
                  depthParen--;
                } else if (char === "[") depthBracket++;
                else if (char === "]") depthBracket--;
                else if (char === "{") depthBrace++;
                else if (char === "}") depthBrace--;
                else if (char === "," && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
                  arg1End = i;
                  break;
                }
              }

              if (arg1End > startIdx) {
                failingExpression = testCodeLine.slice(startIdx, arg1End).trim().slice(0, 120);
              }
            }
          }

          if (!failingExpression && testCodeLine.length > 0 && testCodeLine.length <= 120) {
            failingExpression = testCodeLine;
          }
        }
      }
    } catch {
      // Safe fallback: leave failingExpression undefined
    }
  }

  // 4. Grounded statement matching in currentSourceContext
  let matchedSourceStatement: string | undefined;
  if (params.currentSourceContext) {
    const sourceLines = params.currentSourceContext
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"));

    // Strategy A: Direct return value match (e.g. "return undefined" or "return 6")
    if (actualValue) {
      const returnTarget = actualValue === "undefined" ? "return undefined" : `return ${actualValue}`;
      const foundReturn = sourceLines.find((l) => l.includes(returnTarget));
      if (foundReturn) {
        matchedSourceStatement = foundReturn.slice(0, 160);
      }
    }

    // Strategy B: If no return match, look for function definition corresponding to failingExpression
    if (!matchedSourceStatement && failingExpression) {
      const funcMatch = failingExpression.match(/([a-zA-Z0-9_$]+)\s*\(/);
      if (funcMatch) {
        const funcName = funcMatch[1];
        const foundFunc = sourceLines.find(
          (l) =>
            l.includes(`function ${funcName}`) ||
            l.includes(`${funcName} =`) ||
            l.includes(`${funcName}(`)
        );
        if (foundFunc) {
          matchedSourceStatement = foundFunc.slice(0, 160);
        }
      }
    }

    // Strategy C: Literal inclusion of actualValue in non-empty line
    if (!matchedSourceStatement && actualValue && actualValue.length > 1) {
      const foundLiteral = sourceLines.find((l) => l.includes(actualValue!));
      if (foundLiteral) {
        matchedSourceStatement = foundLiteral.slice(0, 160);
      }
    }
  }

  return {
    assertionKind,
    ...(actualValue !== undefined ? { actualValue } : {}),
    ...(expectedValue !== undefined ? { expectedValue } : {}),
    ...(testFile !== undefined ? { testFile } : {}),
    ...(testLine !== undefined ? { testLine } : {}),
    ...(failingExpression !== undefined ? { failingExpression } : {}),
    ...(matchedSourceStatement !== undefined ? { matchedSourceStatement } : {}),
  };
}

/**
 * Synthesizes structured verification analysis and actionable recovery guidance
 * for failed or regressed intermediate verification runs.
 */
export function deriveVerificationRecoveryGuidance(params: {
  readonly classification: string;
  readonly exitCode: number;
  readonly stderr?: string;
  readonly stdout?: string;
  readonly testDurationMs?: number;
  readonly targetRelPath?: string;
  readonly currentSourceContext?: string;
  readonly workspaceHostPath?: string;
  readonly cleanSpec?: CleanRoomVerificationSpec;
}): {
  readonly verificationAnalysis: VerificationRecoveryAnalysis;
  readonly recoveryAdvisory: string;
} | null {
  if (params.classification === "PASS") {
    return null;
  }

  const parsed = parseAssertionEvidence({
    stderr: params.stderr,
    stdout: params.stdout,
    workspaceHostPath: params.workspaceHostPath,
    targetRelPath: params.targetRelPath,
    currentSourceContext: params.currentSourceContext,
  });

  const assertionKind = parsed?.assertionKind || (params.classification === "TIMEOUT" ? "TIMEOUT" : "ERROR");
  const actualValue = parsed?.actualValue;
  const expectedValue = parsed?.expectedValue;
  const testFile = parsed?.testFile;
  const testLine = parsed?.testLine;
  const failingExpression = parsed?.failingExpression;
  const matchedSourceStatement = parsed?.matchedSourceStatement;
  const targetRelPath = params.targetRelPath;

  let advisory = "";
  if (params.classification === "TIMEOUT") {
    advisory = `Intermediate test TIMED OUT after ${params.testDurationMs ?? 0}ms. Ensure that changes do not introduce infinite loops or unresolved promises.`;
  } else if (failingExpression && actualValue !== undefined && expectedValue !== undefined) {
    advisory = `Intermediate test failed: '${failingExpression}' produced actual value ${actualValue} (expected ${expectedValue}).`;
  } else if (failingExpression) {
    advisory = `Intermediate test failed on '${failingExpression}'.`;
  } else if (actualValue !== undefined && expectedValue !== undefined) {
    advisory = `Intermediate test failed: actual value ${actualValue} (expected ${expectedValue}).`;
  } else {
    advisory = `Intermediate test failed with exit code ${params.exitCode}.`;
  }

  if (matchedSourceStatement && targetRelPath) {
    advisory += ` Grounded target statement in '${targetRelPath}': '${matchedSourceStatement}'.`;
  } else if (targetRelPath) {
    advisory += ` Responsible target file: '${targetRelPath}'.`;
  }

  advisory += ` To resolve this defect, use 'edit_file' with a small, exact literal searchAnchor targeting the defective statement. Do NOT append unrelated comments or declarations to exports. Do NOT invent new helper functions not present in the source.`;

  const verificationAnalysis: VerificationRecoveryAnalysis = {
    assertionKind,
    ...(actualValue !== undefined ? { actualValue } : {}),
    ...(expectedValue !== undefined ? { expectedValue } : {}),
    ...(testFile !== undefined ? { testFile } : {}),
    ...(testLine !== undefined ? { testLine } : {}),
    ...(failingExpression !== undefined ? { failingExpression } : {}),
    ...(targetRelPath !== undefined ? { targetRelPath } : {}),
    ...(matchedSourceStatement !== undefined ? { matchedSourceStatement } : {}),
    recoveryAdvisory: advisory,
  };

  return {
    verificationAnalysis,
    recoveryAdvisory: advisory,
  };
}

// ============================================================================
// 2. Terminal Reasons & Transcript
// ============================================================================

export type StepControllerTerminalReason =
  | "COMPLETED"
  | "NO_ACTION"
  | "MAX_STEPS"
  | "MAX_WALL_CLOCK"
  | "MAX_ACTIONS"
  | "MAX_FAILURES"
  | "MAX_PROPOSAL_REJECTIONS"
  | "CANCELLED"
  | "LEASE_LOST"
  | "CONTRACT_REVOKED"
  | "UNKNOWN_EXECUTION"
  | "CONTEXT_BUDGET_EXCEEDED"
  | "BRAIN_FAILURE"
  | "DEFERRED"
  | "STAGNATION"
  | "CYCLE_DETECTED"
  | "POLICY_DENIED"
  | "COMPLETION_UNVERIFIABLE"
  | "WAITING_APPROVAL"
  | "APPROVAL_REJECTED"
  | "APPROVAL_EXPIRED"
  | "REPAIR_EXHAUSTED";

/**
 * Structured reason a completion proposal was not authorized. Never contains model output.
 */
export type CompletionRejectionCode =
  | "NO_VERIFICATION_SPECS"
  | "UNSUPPORTED_VERIFICATION_RULE"
  | "CLEAN_ROOM_VERIFIER_UNAVAILABLE"
  | "CLEAN_ROOM_WORKSPACE_UNAVAILABLE"
  | "CLEAN_ROOM_NOT_EVALUATED"
  | "CLEAN_ROOM_NOT_VERIFIED"
  | "MISSING_EVIDENCE"
  | "VERIFICATION_FAILED";

/**
 * Typed result of the authoritative completion evaluation (MODEL_GOAL_REACHED != RUN_COMPLETED).
 * `verified` is true only when every required specification produced a VERIFIED result.
 */
export interface CompletionEvaluation {
  readonly verified: boolean;
  readonly failureReason?: string;
  readonly specResults: readonly VerificationResult[];
  readonly requirementsSummary?: Record<string, string>;
  readonly outstandingRequirements?: readonly string[];
  readonly rejectionCode?: CompletionRejectionCode;
  /** True when no further model action can satisfy the contract (terminal COMPLETION_UNVERIFIABLE). */
  readonly unverifiable?: boolean;
  /** True only when every other spec verified and an independent clean-room run is still required. */
  readonly cleanRoomPending?: boolean;
  readonly leaseLost?: boolean;
}

/** Runtime dependencies available to the evaluator; absence of a required dependency fails closed. */
export interface CompletionEvaluationContext {
  readonly cleanRoomVerifierAvailable: boolean;
  readonly workspaceAvailable: boolean;
  readonly cleanRoomOutcome?: CleanRoomVerificationOutcome;
  readonly leaseFencing?: LeaseFencingCheck;
}

export interface StepTranscriptEntry {
  readonly stepNumber: number;
  readonly contextSnapshotId: string;
  readonly contextHash: string;
  readonly contextEstimatedTokens: number;
  readonly contextBytes: number;
  readonly contextObservationsCount: number;
  readonly proposalId?: string;
  readonly toolName?: ExtendedToolName;
  readonly inputHash?: string;
  readonly inputPayload?: unknown;
  readonly rationale?: string;
  readonly finishReason?: BrainFinishReason;
  readonly proposalValid: boolean;
  readonly proposalRejectionReason?: ProposalRejectionReason;
  readonly proposalRejectionMessage?: string;
  readonly reflexDecision?: ReflexDecisionKind;
  readonly reflexReasonCode?: ReflexReasonCode;
  readonly reflexRationale?: string;
  readonly reflexEvidence?: ReflexEvidence;
  readonly reflexError?: string;
  readonly reflexDurationMs?: number;
  readonly actionId?: string;
  readonly actionStatus?: WorkerActionStatus;
  readonly actionOutput?: unknown;
  readonly actionError?: unknown;
  readonly progressAdvisory?: string;
  readonly eligibleTools?: readonly string[];
  readonly filteredTools?: readonly string[];
  readonly durationMs: number;
  readonly timestamp: string;
}

export interface StepControllerResult {
  readonly runId: string;
  readonly taskId: string;
  readonly terminalReason: StepControllerTerminalReason;
  readonly terminalMessage: string;
  readonly totalSteps: number;
  readonly totalActions: number;
  readonly totalAgentActions?: number;
  readonly totalVerificationActions?: number;
  readonly totalProposalRejections: number;
  readonly totalConsecutiveFailures: number;
  readonly totalWallClockMs: number;
  readonly transcript: readonly StepTranscriptEntry[];
  readonly lastContextSnapshot?: ContextSnapshot;
  readonly postPassLatchSnapshot?: PostPassLatchSnapshot;
  readonly latestCheckpoint?: MissionCheckpoint;
  readonly pendingApprovalId?: string;
  readonly pendingApprovalOperation?: string;
}

// ============================================================================
// 3. Controller Configuration & Parameters
// ============================================================================

export interface AgentStepControllerOptions {
  readonly coordinator: RunCoordinator;
  readonly stateStore: StateStorePort;
  readonly workerRuntime: WorkerRuntime;
  readonly agentBrain: AgentBrainPort;
  readonly proposalValidator?: ProposalValidator;
  readonly toolRegistry?: ToolRegistryPort;
  readonly contextSource?: ContextSourcePort;
  readonly clock?: ClockPort;
  readonly defaultBudget?: Partial<StepControllerBudget>;
  readonly reflex?: ReflexPort;
  readonly enableGovernedVerificationStage?: boolean;
  readonly cleanRoomVerifier?: CleanRoomVerifier;
  /**
   * Explicit, auditable operator opt-in to authorize completion for a Mission Contract that declares NO
   * verification specifications. Default false: an empty specification set is not proof of success and a
   * completion claim is then rejected as COMPLETION_UNVERIFIABLE. When enabled, every authorization is
   * recorded durably as a "verification.unverified_completion_authorized" event.
   */
  readonly allowUnverifiedCompletion?: boolean;
  readonly speculativePromotionGate?: import("./speculative-promotion-gate.js").SpeculativePromotionGate;
  readonly speculativePolicy?: import("./runtime-speculative-execution-policy.js").RuntimeSpeculativeExecutionPolicy;
  /**
   * Whether dynamic context-aware tool filtering is enabled.
   * Default: false (preserves static schema behavior).
   */
  readonly enableDynamicToolFiltering?: boolean;
  readonly contextResidencyTracker?: ContextResidencyTracker;
  readonly failedAnchorTracker?: FailedAnchorTracker;
  readonly duplicateProposalDetector?: DuplicateProposalDetector;
  readonly progressLoopDetector?: ProgressLoopDetector;
  readonly scopedMemory?: ScopedContextMemoryService;
  readonly boundedRepairLoop?: BoundedRepairLoopController;
  readonly productionVerifier?: ProductionVerifier;
  readonly telemetry?: EmeraldLifecycleTelemetry;
}


export interface RunStepLoopParams {
  readonly runId: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly workspace?: {
    readonly workspaceId: string;
    readonly hostPath: string;
    readonly containerMountPath?: string;
  };
  readonly budget?: Partial<StepControllerBudget>;
  readonly contextBudget?: ContextBudget;
  readonly abortSignal?: AbortSignal;
  readonly enableGovernedVerificationStage?: boolean;
  /**
   * Override for dynamic context-aware tool filtering for this run.
   * Default: falls back to controller option (default: false).
   */
  readonly enableDynamicToolFiltering?: boolean;
  /**
   * Whether to restore loop counters and verification latch from the latest durable checkpoint.
   * Default: true.
   */
  readonly restoreFromCheckpoint?: boolean;
  /**
   * Whether to persist durable checkpoints at defined safe boundaries.
   * Default: true.
   */
  readonly persistCheckpoints?: boolean;
}

// ============================================================================
// 4. Step Controller Implementation
// ============================================================================

export class AgentStepController {
  private readonly coordinator: RunCoordinator;
  private readonly stateStore: StateStorePort;
  private readonly workerRuntime: WorkerRuntime;
  private readonly agentBrain: AgentBrainPort;
  private readonly proposalValidator: ProposalValidator;
  private readonly toolRegistry: ToolRegistryPort;
  private readonly contextSource: ContextSourcePort;
  private readonly clock: ClockPort;
  private readonly defaultBudget: StepControllerBudget;
  private readonly reflex: ReflexPort;
  private readonly enableGovernedVerificationStage: boolean;
  private readonly cleanRoomVerifier?: CleanRoomVerifier;
  private readonly allowUnverifiedCompletion: boolean;
  private readonly speculativePromotionGate?: import("./speculative-promotion-gate.js").SpeculativePromotionGate;
  private readonly speculativePolicy?: import("./runtime-speculative-execution-policy.js").RuntimeSpeculativeExecutionPolicy;
  private readonly enableDynamicToolFiltering: boolean;
  private readonly contextResidencyTracker: ContextResidencyTracker;
  private readonly failedAnchorTracker: FailedAnchorTracker;
  private readonly duplicateProposalDetector: DuplicateProposalDetector;
  private readonly postPassLatch: PostPassVerificationLatch;
  readonly progressLoopDetector: ProgressLoopDetector;
  private readonly scopedMemory?: ScopedContextMemoryService;
  private readonly boundedRepairLoop: BoundedRepairLoopController;
  private readonly productionVerifier?: ProductionVerifier;
  private readonly telemetry?: EmeraldLifecycleTelemetry;

  constructor(options: AgentStepControllerOptions) {
    this.coordinator = options.coordinator;
    this.stateStore = options.stateStore;
    this.workerRuntime = options.workerRuntime;
    this.agentBrain = options.agentBrain;
    this.toolRegistry = options.toolRegistry ?? defaultGovernedToolRegistry;
    this.clock = options.clock ?? new SystemClock();
    this.reflex = options.reflex ?? new NoopReflex();
    this.enableGovernedVerificationStage =
      options.enableGovernedVerificationStage ?? true;
    this.cleanRoomVerifier = options.cleanRoomVerifier;
    this.allowUnverifiedCompletion = options.allowUnverifiedCompletion ?? false;
    this.speculativePromotionGate = options.speculativePromotionGate;
    this.speculativePolicy = options.speculativePolicy;
    this.enableDynamicToolFiltering = options.enableDynamicToolFiltering ?? false;
    this.failedAnchorTracker =
      options.failedAnchorTracker ?? new FailedAnchorTracker();
    this.duplicateProposalDetector =
      options.duplicateProposalDetector ?? new DuplicateProposalDetector();
    this.postPassLatch = new PostPassVerificationLatch();
    this.contextResidencyTracker =
      options.contextResidencyTracker ??
      new ContextResidencyTracker({
        enableDynamicToolFiltering: this.enableDynamicToolFiltering,
      });

    this.proposalValidator =
      options.proposalValidator ??
      new ProposalValidator({
        coordinator: this.coordinator,
        stateStore: this.stateStore,
        toolRegistry: this.toolRegistry,
        clock: this.clock,
      });

    this.contextSource =
      options.contextSource ?? new ContextSource(this.stateStore);

    this.defaultBudget = Object.freeze({
      ...DEFAULT_STEP_CONTROLLER_BUDGET,
      ...options.defaultBudget,
    });

    this.progressLoopDetector =
      options.progressLoopDetector ??
      new ProgressLoopDetector({
        stagnationRepetitionThreshold:
          this.defaultBudget.maxConsecutiveCycleRepetitions ??
          DEFAULT_MAX_CONSECUTIVE_CYCLE_REPETITIONS,
        maxCycleLength:
          this.defaultBudget.maxCycleLength ?? DEFAULT_MAX_CYCLE_LENGTH,
      });
    this.telemetry = options.telemetry;
    this.scopedMemory =
      options.scopedMemory ??
      (typeof (this.stateStore as any).getScopedMemoryStore === "function"
        ? new ScopedContextMemoryService((this.stateStore as any).getScopedMemoryStore(), {
            clock: this.clock,
            telemetry: this.telemetry,
          })
        : undefined);
    this.boundedRepairLoop = options.boundedRepairLoop ?? new BoundedRepairLoopController();
    this.productionVerifier = options.productionVerifier ?? new ProductionVerifier(this.clock, this.telemetry);
  }

  getContextResidencyTracker(): ContextResidencyTracker {
    return this.contextResidencyTracker;
  }

  getFailedAnchorTracker(): FailedAnchorTracker {
    return this.failedAnchorTracker;
  }

  getDuplicateProposalDetector(): DuplicateProposalDetector {
    return this.duplicateProposalDetector;
  }

  getPostPassVerificationLatch(): PostPassVerificationLatch {
    return this.postPassLatch;
  }

  get promotionGate(): import("./speculative-promotion-gate.js").SpeculativePromotionGate | undefined {
    return this.speculativePromotionGate;
  }

  get runtimeSpeculativePolicy(): import("./runtime-speculative-execution-policy.js").RuntimeSpeculativeExecutionPolicy | undefined {
    return this.speculativePolicy;
  }


  /**
   * Executes the bounded autonomous step loop for an actively leased Run.
   */
  async runStepLoop(params: RunStepLoopParams): Promise<StepControllerResult> {
    const { runId, workerId, leaseId } = params;

    if (!runId || typeof runId !== "string" || runId.trim().length === 0) {
      throw new Error("runStepLoop requires a non-empty runId");
    }
    if (!workerId || typeof workerId !== "string" || workerId.trim().length === 0) {
      throw new Error("runStepLoop requires a non-empty workerId");
    }
    if (!leaseId || typeof leaseId !== "string" || leaseId.trim().length === 0) {
      throw new Error("runStepLoop requires a non-empty leaseId");
    }

    const effectiveBudget: StepControllerBudget = Object.freeze({
      ...this.defaultBudget,
      ...params.budget,
    });
    const effectiveDynamicToolFiltering =
      params.enableDynamicToolFiltering ?? this.enableDynamicToolFiltering;

    const startTime = this.clock.now().getTime();
    this.failedAnchorTracker.clearAll();
    this.duplicateProposalDetector.clearAll();
    this.postPassLatch.clear();
    this.progressLoopDetector.configure({
      stagnationRepetitionThreshold:
        effectiveBudget.maxConsecutiveCycleRepetitions ??
        DEFAULT_MAX_CONSECUTIVE_CYCLE_REPETITIONS,
      maxCycleLength:
        effectiveBudget.maxCycleLength ?? DEFAULT_MAX_CYCLE_LENGTH,
    });
    this.progressLoopDetector.clearAll();
    const existingActions = this.stateStore.getActionsForRun(runId);
    if (existingActions && existingActions.length > 0) {
      this.progressLoopDetector.reconstructFromDurableHistory(
        existingActions,
        (actionId) => this.stateStore.getAttemptsForAction(actionId)
      );
    }
    const transcript: StepTranscriptEntry[] = [];
    let stepCount = 0;
    let agentActionCount = 0;
    let verificationActionCount = 0;
    let consecutiveFailures = 0;
    let proposalRejections = 0;
    let lastContextSnapshot: ContextSnapshot | undefined;
    let pendingProposalRejectionObservation: Observation | null = null;
    let pendingProgressAdvisoryObservation: Observation | null = null;
    let pendingTestFeedbackObservation: Observation | null = null;
    let pendingActionRecoveryObservation: Observation | null = null;
    let pendingCycleStop: ProgressAssessment | null = null;
    let cycleAdvisoryIssued = false;
    let consecutiveIdenticalReads = 0;
    let consecutiveIdenticalWrites = 0;
    let consecutiveIneffectiveEdits = 0;
    let hasRecordedTaskMemory = false;
    let hasObservedRepairFailure = false;
    let repairState: RepairCycleState | undefined;
    let pendingApprovalIdResult: string | undefined;
    let pendingApprovalOpResult: string | undefined;
    // Run-loop-local: replay-block results returned by WorkerRuntime in this invocation (not persisted).
    let replayBlockCount = 0;
    let lastSuccessfulRead:
      | {
          readonly path: string;
          readonly inputHash: string;
          readonly outputHash: string;
          consecutiveCount: number;
          advisoryIssued: boolean;
        }
      | undefined;
    // Repeating the same successful write_file (same path and requested content) changes nothing.
    let lastSuccessfulWrite:
      | {
          readonly path: string;
          readonly inputHash: string;
          consecutiveCount: number;
          advisoryIssued: boolean;
        }
      | undefined;

    // Helper to assemble final StepControllerResult
    const assembleResult = (
      reason: StepControllerTerminalReason,
      message: string,
      taskId: string
    ): StepControllerResult => {
      const totalWallClockMs = this.clock.now().getTime() - startTime;
      const latestCheckpoint = this.stateStore.getLatestCheckpoint(runId);
      return Object.freeze({
        runId,
        taskId,
        terminalReason: reason,
        terminalMessage: message,
        totalSteps: stepCount,
        totalActions: agentActionCount + verificationActionCount,
        totalAgentActions: agentActionCount,
        totalVerificationActions: verificationActionCount,
        totalProposalRejections: proposalRejections,
        totalConsecutiveFailures: consecutiveFailures,
        totalWallClockMs,
        transcript: Object.freeze([...transcript]),
        ...(lastContextSnapshot ? { lastContextSnapshot } : {}),
        postPassLatchSnapshot: this.postPassLatch.getSnapshot(),
        ...(latestCheckpoint ? { latestCheckpoint } : {}),
        ...(pendingApprovalIdResult ? { pendingApprovalId: pendingApprovalIdResult } : {}),
        ...(pendingApprovalOpResult ? { pendingApprovalOperation: pendingApprovalOpResult } : {}),
      });
    };

    // Initial pre-loop authoritative validation
    const initialRun = this.stateStore.getRun(runId);
    if (!initialRun) {
      return assembleResult("LEASE_LOST", `Run '${runId}' not found in state store`, "unknown");
    }
    const taskId = initialRun.taskId;
    repairState = this.boundedRepairLoop.initCycle(taskId, runId);

    // Phase 2.16-B: Checkpoint Restoration & Reconciliation
    let currentCheckpointVersion = 0;
    const initialLatestCheckpoint = this.stateStore.getLatestCheckpoint(runId);
    if (initialLatestCheckpoint) {
      currentCheckpointVersion = initialLatestCheckpoint.checkpointVersion;
      if (params.restoreFromCheckpoint !== false) {
        if (!initialRun.contractBinding) {
          return assembleResult(
            "CONTRACT_REVOKED",
            `Run '${runId}' has no bound Mission Contract`,
            taskId
          );
        }
        const initialContract = this.stateStore.getContract(
          initialRun.contractBinding.contractId,
          initialRun.contractBinding.version
        );
        if (!initialContract || initialContract.lifecycle.status !== "ACTIVE") {
          return assembleResult(
            "CONTRACT_REVOKED",
            `Bound Mission Contract '${initialRun.contractBinding.contractId}' is not ACTIVE`,
            taskId
          );
        }

        const runActions = this.stateStore.getActionsForRun(runId);
        const runEvents = this.stateStore.getEventsForRun(runId);
        const runAttempts: AttemptSnapshot[] = [];
        for (const act of runActions) {
          const atts = this.stateStore.getAttemptsForAction(act.actionId);
          runAttempts.push(...atts);
        }

        try {
          const reconciliation = reconcileCheckpointWithDurableEvidence({
            checkpoint: initialLatestCheckpoint,
            runSnapshot: initialRun,
            contract: initialContract,
            actions: runActions,
            attempts: runAttempts,
            events: runEvents,
            clock: this.clock,
          });

          if (reconciliation.status === "ALREADY_VERIFIED") {
            return assembleResult(
              "COMPLETED",
              reconciliation.reason ??
                "Run already verified by authoritative verification evidence (Scenario 12)",
              taskId
            );
          }

          if (reconciliation.status === "FAIL_CLOSED") {
            return assembleResult(
              "POLICY_DENIED",
              reconciliation.reason ?? "Checkpoint reconciliation failed closed",
              taskId
            );
          }

          const dState = reconciliation.durableState;
          stepCount = reconciliation.reconciledStepCount;
          // Verification actions recorded by the checkpoint stay on the verification budget; anything
          // reconciled beyond the checkpoint is charged to the agent budget (conservative).
          verificationActionCount = Math.min(
            dState.verificationActionCount ?? 0,
            reconciliation.reconciledActionCount
          );
          agentActionCount = reconciliation.reconciledActionCount - verificationActionCount;
          consecutiveFailures = reconciliation.reconciledConsecutiveFailures;
          proposalRejections = dState.proposalRejections;
          consecutiveIdenticalReads = dState.consecutiveIdenticalReads;
          consecutiveIdenticalWrites = dState.consecutiveIdenticalWrites;
          consecutiveIneffectiveEdits = dState.consecutiveIneffectiveEdits;

          if (dState.postPassLatchSnapshot) {
            this.postPassLatch.restoreFromSnapshot(dState.postPassLatchSnapshot);
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return assembleResult(
            "POLICY_DENIED",
            `Checkpoint restoration rejected: ${errMsg}`,
            taskId
          );
        }
      }
    }

    const shouldPersistCheckpoints =
      params.persistCheckpoints !== false &&
      effectiveBudget.enableCheckpointing !== false;

    let currentLastActionId: string | null =
      initialLatestCheckpoint?.actionId ??
      (initialLatestCheckpoint?.durableState as any)?.lastActionId ??
      null;
    let currentLastAttemptNumber: number | null =
      initialLatestCheckpoint?.attemptNumber ??
      (initialLatestCheckpoint?.durableState as any)?.lastAttemptNumber ??
      null;

    // 2.16-D: set when a worker-fenced checkpoint write is rejected for lost/expired lease authority.
    // The loop must stop at its next boundary; storage-level errors remain non-fatal as before.
    let checkpointAuthorityLostReason: string | null = null;

    const persistLoopCheckpoint = (
      lastActionId?: string | null,
      lastAttemptNumber?: number | null
    ) => {
      if (!shouldPersistCheckpoints || checkpointAuthorityLostReason !== null) return;
      currentCheckpointVersion++;
      if (lastActionId !== undefined) {
        currentLastActionId = lastActionId;
      }
      if (lastAttemptNumber !== undefined) {
        currentLastAttemptNumber = lastAttemptNumber;
      }
      try {
        saveStepLoopCheckpoint({
          coordinator: this.coordinator,
          stateStore: this.stateStore,
          clock: this.clock,
          runId,
          stepCount,
          actionCount: agentActionCount + verificationActionCount,
          verificationActionCount,
          consecutiveFailures,
          proposalRejections,
          consecutiveIdenticalReads,
          consecutiveIdenticalWrites,
          consecutiveIneffectiveEdits,
          postPassLatch: this.postPassLatch,
          lastActionId: currentLastActionId,
          lastAttemptNumber: currentLastAttemptNumber,
          currentCheckpointVersion,
          workerFencing: { workerId, leaseId },
        });
      } catch (err: unknown) {
        if (err instanceof LeaseLostError || err instanceof LeaseExpiredError) {
          checkpointAuthorityLostReason = err.message;
          return;
        }
        // Safe persistence fallback: storage errors do not crash running memory loop
      }
    };

    const hasActiveLeaseAuthority = (): string | null => {
      const activeRun = this.stateStore.getRun(runId);
      if (!activeRun) {
        return `Run '${runId}' not found during loop step`;
      }
      if (activeRun.leaseId !== leaseId || activeRun.currentWorkerId !== workerId) {
        return `Worker lease ownership lost for run '${runId}' (expected lease: '${activeRun.leaseId}', held: '${leaseId}')`;
      }
      if (activeRun.leaseExpiresAt && this.clock.nowIso() >= activeRun.leaseExpiresAt) {
        return `Worker lease expired at '${activeRun.leaseExpiresAt}'`;
      }
      return null;
    };

    let hasAttemptedStagnationVerification = false;

    // ------------------------------------------------------------------------
    // The Autonomous Step Loop
    // ------------------------------------------------------------------------
    while (true) {
      const nowMs = this.clock.now().getTime();
      const elapsedMs = nowMs - startTime;

      // 0. Check Lease Authority (Lease loss / expiry takes precedence over cancellation and timeout)
      const loopLeaseLossReason = hasActiveLeaseAuthority();
      if (loopLeaseLossReason !== null) {
        return assembleResult(
          "LEASE_LOST",
          `Autonomous loop fenced due to lost or expired lease: ${loopLeaseLossReason}`,
          taskId
        );
      }

      // 1. Check Cancellation
      if (params.abortSignal?.aborted) {
        return assembleResult("CANCELLED", "Autonomous loop aborted by AbortSignal", taskId);
      }

      // 1b. A fenced checkpoint write was rejected: this worker no longer holds authority.
      if (checkpointAuthorityLostReason !== null) {
        return assembleResult(
          "LEASE_LOST",
          `Worker authority lost during checkpoint persistence: ${checkpointAuthorityLostReason}`,
          taskId
        );
      }

      // 2. Check Wall-Clock Budget
      if (elapsedMs >= effectiveBudget.maxWallClockMs) {
        return assembleResult(
          "MAX_WALL_CLOCK",
          `Wall clock ceiling reached (${elapsedMs}ms >= ${effectiveBudget.maxWallClockMs}ms)`,
          taskId
        );
      }

      // 3. Check Step Budget
      if (stepCount >= effectiveBudget.maxSteps) {
        return assembleResult(
          "MAX_STEPS",
          `Maximum reasoning steps ceiling reached (${stepCount} >= ${effectiveBudget.maxSteps})`,
          taskId
        );
      }

      // 4. Check Agent Action Budget (Milestone 2.28 Phase 5 Step 12: do not silently skip verification)
      if (agentActionCount >= effectiveBudget.maxActions) {
        const isVerificationStageEnabled =
          params.enableGovernedVerificationStage ??
          this.enableGovernedVerificationStage ??
          true;

        const checkRun = this.stateStore.getRun(runId);
        const checkContract = checkRun?.contractBinding
          ? this.stateStore.getContract(checkRun.contractBinding.contractId, checkRun.contractBinding.version)
          : null;

        if (isVerificationStageEnabled && checkContract && (checkContract.spec.verificationSpecs?.length ?? 0) > 0) {
          const stepStartTime = this.clock.now().getTime();
          const stepTimestamp = this.clock.nowIso();
          const exhaustionSnapshot: ContextSnapshot = lastContextSnapshot ?? ContextEngine.build({
            runId,
            taskId,
            candidates: [],
            budget: params.contextBudget,
            createdAt: stepTimestamp,
          });

          const stageResult = await this.executeGovernedVerificationStage({
            runId,
            taskId,
            contract: checkContract,
            workerId,
            leaseId,
            workspace: params.workspace,
            abortSignal: params.abortSignal,
            effectiveBudget,
            currentAgentActionCount: agentActionCount,
            currentVerificationActionCount: verificationActionCount,
            consecutiveFailures,
            replayBlockCount,
            stepCount,
            startTime,
            stepStartTime,
            stepTimestamp,
            contextSnapshot: exhaustionSnapshot,
            transcript,
            assembleResult: (reason, message) => assembleResult(reason, message, taskId),
          });

          agentActionCount = stageResult.updatedAgentActionCount;
          verificationActionCount = stageResult.updatedVerificationActionCount;
          if (!stageResult.terminalResult && stageResult.lastVerificationActionId) {
            persistLoopCheckpoint(
              stageResult.lastVerificationActionId,
              stageResult.lastVerificationAttemptNumber ?? null
            );
          }
          consecutiveFailures = stageResult.updatedConsecutiveFailures;
          replayBlockCount = stageResult.updatedReplayBlockCount;

          if (stageResult.terminalResult) {
            return stageResult.terminalResult;
          }

          const completionContext: CompletionEvaluationContext = {
            cleanRoomVerifierAvailable: Boolean(this.cleanRoomVerifier),
            workspaceAvailable: Boolean(params.workspace),
            leaseFencing: { workerId, leaseId },
          };

          const verificationEvaluation = this.evaluateCompletionVerification(
            runId,
            checkContract,
            completionContext
          );
          if (verificationEvaluation.leaseLost) {
            return assembleResult(
              "LEASE_LOST",
              verificationEvaluation.failureReason ?? `Lease lost during completion verification`,
              taskId
            );
          }

          if (verificationEvaluation.verified) {
            transcript.push(
              Object.freeze({
                stepNumber: stepCount,
                contextSnapshotId: exhaustionSnapshot.snapshotId,
                contextHash: exhaustionSnapshot.contextHash,
                contextEstimatedTokens: exhaustionSnapshot.totalEstimatedTokens,
                contextBytes: exhaustionSnapshot.totalBytes,
                contextObservationsCount: exhaustionSnapshot.observations.length,
                finishReason: "GOAL_REACHED",
                proposalValid: false,
                durationMs: this.clock.now().getTime() - stepStartTime,
                timestamp: stepTimestamp,
              })
            );

            return assembleResult(
              "COMPLETED",
              "Agent completed work and mandatory verification succeeded",
              taskId
            );
          }
        }

        return assembleResult(
          "MAX_ACTIONS",
          `Maximum agent action execution ceiling reached (${agentActionCount} >= ${effectiveBudget.maxActions})`,
          taskId
        );
      }

      // 5. Check Proposal Rejection Budget
      if (proposalRejections >= effectiveBudget.maxProposalRejections) {
        return assembleResult(
          "MAX_PROPOSAL_REJECTIONS",
          `Maximum proposal rejections ceiling reached (${proposalRejections} >= ${effectiveBudget.maxProposalRejections})`,
          taskId
        );
      }

      // 6. Check Consecutive Failures Budget
      if (consecutiveFailures >= effectiveBudget.maxConsecutiveFailures) {
        return assembleResult(
          "MAX_FAILURES",
          `Maximum consecutive action failures ceiling reached (${consecutiveFailures} >= ${effectiveBudget.maxConsecutiveFailures})`,
          taskId
        );
      }

      // 7. Check Stagnation (Consecutive Identical Reads) Budget
      const maxConsecutiveIdenticalReads =
        effectiveBudget.maxConsecutiveIdenticalReads ??
        DEFAULT_MAX_CONSECUTIVE_IDENTICAL_READS;
      let stagnationReason: string | null = null;
      if (consecutiveIdenticalReads >= maxConsecutiveIdenticalReads) {
        stagnationReason = `Execution loop halted due to stagnation: ${consecutiveIdenticalReads} consecutive identical successful reads of '${lastSuccessfulRead?.path ?? "unknown"}' without progress`;
      }

      // 7a. Check Stagnation (Consecutive Identical Successful Writes) Budget
      const maxConsecutiveIdenticalWrites =
        effectiveBudget.maxConsecutiveIdenticalWrites ??
        DEFAULT_MAX_CONSECUTIVE_IDENTICAL_WRITES;
      if (!stagnationReason && consecutiveIdenticalWrites >= maxConsecutiveIdenticalWrites) {
        stagnationReason = `Execution loop halted due to stagnation: ${consecutiveIdenticalWrites} consecutive identical successful writes of '${lastSuccessfulWrite?.path ?? "unknown"}' without progress`;
      }

      // 7b. Check Stagnation (Consecutive Ineffective Edits) Budget
      const maxConsecutiveIneffectiveEdits =
        effectiveBudget.maxConsecutiveIneffectiveEdits ??
        DEFAULT_MAX_CONSECUTIVE_INEFFECTIVE_EDITS;
      if (!stagnationReason && consecutiveIneffectiveEdits >= maxConsecutiveIneffectiveEdits) {
        stagnationReason = `Execution loop halted due to stagnation: ${consecutiveIneffectiveEdits} consecutive ineffective edit attempts failed to produce passing test results`;
      }

      // Stagnation-Aware System-Owned Verification Gate (Milestone 2.28 Phase 5 Step 13)
      if (stagnationReason !== null) {
        // Repeated stagnation signals must not trigger unlimited verification
        if (hasAttemptedStagnationVerification) {
          return assembleResult("STAGNATION", stagnationReason, taskId);
        }

        // Terminal-state precedence: FENCING > TIMEOUT > CANCELLED > SUCCESS
        // 1. Cancellation precedence
        if (params.abortSignal?.aborted) {
          return assembleResult(
            "CANCELLED",
            `Loop aborted by AbortSignal prior to stagnation verification: ${stagnationReason}`,
            taskId
          );
        }

        // 2. Overall wall-clock budget precedence
        const stagnationElapsedMs = this.clock.now().getTime() - startTime;
        if (stagnationElapsedMs >= effectiveBudget.maxWallClockMs) {
          return assembleResult(
            "MAX_WALL_CLOCK",
            `Wall clock ceiling reached prior to stagnation verification (${stagnationElapsedMs}ms >= ${effectiveBudget.maxWallClockMs}ms)`,
            taskId
          );
        }

        // 3. Lease & fencing precedence
        const preStagnationRun = this.stateStore.getRun(runId);
        if (!preStagnationRun) {
          return assembleResult("LEASE_LOST", `Run '${runId}' not found during stagnation check`, taskId);
        }
        if (preStagnationRun.leaseId !== leaseId || preStagnationRun.currentWorkerId !== workerId) {
          return assembleResult(
            "LEASE_LOST",
            `Worker lease ownership lost for run '${runId}' prior to stagnation verification (expected lease: '${preStagnationRun.leaseId}', held: '${leaseId}')`,
            taskId
          );
        }
        if (preStagnationRun.leaseExpiresAt && this.clock.nowIso() >= preStagnationRun.leaseExpiresAt) {
          return assembleResult(
            "LEASE_LOST",
            `Worker lease expired at '${preStagnationRun.leaseExpiresAt}' prior to stagnation verification`,
            taskId
          );
        }
        const terminalStatuses: readonly string[] = ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"];
        if (terminalStatuses.includes(preStagnationRun.status)) {
          return assembleResult(
            "COMPLETED",
            `Run reached terminal status '${preStagnationRun.status}'`,
            taskId
          );
        }

        // Contract & verification specifications bound to persisted task contract
        const isVerificationStageEnabled =
          params.enableGovernedVerificationStage ??
          this.enableGovernedVerificationStage ??
          true;

        const checkContract = preStagnationRun.contractBinding
          ? this.stateStore.getContract(preStagnationRun.contractBinding.contractId, preStagnationRun.contractBinding.version)
          : null;

        if (
          !isVerificationStageEnabled ||
          !checkContract ||
          (checkContract.spec.verificationSpecs?.length ?? 0) === 0 ||
          !params.workspace
        ) {
          // Stagnation without verification specs fails closed
          return assembleResult("STAGNATION", stagnationReason, taskId);
        }

        // Single system-owned verification attempt against final workspace state
        hasAttemptedStagnationVerification = true;
        const stepStartTime = this.clock.now().getTime();
        const stepTimestamp = this.clock.nowIso();
        const stagnationSnapshot: ContextSnapshot = lastContextSnapshot ?? ContextEngine.build({
          runId,
          taskId,
          candidates: [],
          budget: params.contextBudget,
          createdAt: stepTimestamp,
        });

        const stageResult = await this.executeGovernedVerificationStage({
          runId,
          taskId,
          contract: checkContract,
          workerId,
          leaseId,
          workspace: params.workspace,
          abortSignal: params.abortSignal,
          effectiveBudget,
          currentAgentActionCount: agentActionCount,
          currentVerificationActionCount: verificationActionCount,
          consecutiveFailures,
          replayBlockCount,
          stepCount,
          startTime,
          stepStartTime,
          stepTimestamp,
          contextSnapshot: stagnationSnapshot,
          transcript,
          assembleResult: (reason, message) => assembleResult(reason, message, taskId),
        });

        agentActionCount = stageResult.updatedAgentActionCount;
        verificationActionCount = stageResult.updatedVerificationActionCount;
        if (!stageResult.terminalResult && stageResult.lastVerificationActionId) {
          persistLoopCheckpoint(
            stageResult.lastVerificationActionId,
            stageResult.lastVerificationAttemptNumber ?? null
          );
        }
        consecutiveFailures = stageResult.updatedConsecutiveFailures;
        replayBlockCount = stageResult.updatedReplayBlockCount;

        if (stageResult.terminalResult) {
          return stageResult.terminalResult;
        }

        const completionContext: CompletionEvaluationContext = {
          cleanRoomVerifierAvailable: Boolean(this.cleanRoomVerifier),
          workspaceAvailable: Boolean(params.workspace),
          leaseFencing: { workerId, leaseId },
        };

        const verificationEvaluation = this.evaluateCompletionVerification(
          runId,
          checkContract,
          completionContext
        );
        if (verificationEvaluation.leaseLost) {
          return assembleResult(
            "LEASE_LOST",
            verificationEvaluation.failureReason ?? `Lease lost during completion verification`,
            taskId
          );
        }

        if (verificationEvaluation.verified) {
          transcript.push(
            Object.freeze({
              stepNumber: stepCount,
              contextSnapshotId: stagnationSnapshot.snapshotId,
              contextHash: stagnationSnapshot.contextHash,
              contextEstimatedTokens: stagnationSnapshot.totalEstimatedTokens,
              contextBytes: stagnationSnapshot.totalBytes,
              contextObservationsCount: stagnationSnapshot.observations.length,
              finishReason: "GOAL_REACHED",
              proposalValid: false,
              durationMs: this.clock.now().getTime() - stepStartTime,
              timestamp: stepTimestamp,
            })
          );

          return assembleResult(
            "COMPLETED",
            "Agent work completed via stagnation verification against valid workspace state",
            taskId
          );
        }

        // If verification fails after stagnation, retain the original stagnation failure classification
        return assembleResult(
          "STAGNATION",
          stagnationReason,
          taskId
        );
      }

      // 8. Verify Authoritative Run & Lease Ownership
      const currentRun = this.stateStore.getRun(runId);
      if (!currentRun) {
        return assembleResult("LEASE_LOST", `Run '${runId}' not found during loop step`, taskId);
      }

      if (currentRun.leaseId !== leaseId || currentRun.currentWorkerId !== workerId) {
        return assembleResult(
          "LEASE_LOST",
          `Worker lease ownership lost for run '${runId}' (expected lease: '${currentRun.leaseId}', held: '${leaseId}')`,
          taskId
        );
      }

      if (currentRun.leaseExpiresAt && this.clock.nowIso() >= currentRun.leaseExpiresAt) {
        return assembleResult(
          "LEASE_LOST",
          `Worker lease expired at '${currentRun.leaseExpiresAt}'`,
          taskId
        );
      }

      const terminalStatuses: readonly string[] = ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"];
      if (terminalStatuses.includes(currentRun.status)) {
        return assembleResult(
          "COMPLETED",
          `Run reached terminal status '${currentRun.status}'`,
          taskId
        );
      }

      // 8a. Check Multi-Step Ineffective Cycle Stagnation
      if (pendingCycleStop) {
        return assembleResult(
          "CYCLE_DETECTED",
          `Execution loop halted due to cycle stagnation: ${pendingCycleStop.reason}`,
          taskId
        );
      }

      // 9. Verify Mission Contract Lifecycle
      if (!currentRun.contractBinding) {
        return assembleResult(
          "CONTRACT_REVOKED",
          `Run '${runId}' has no bound Mission Contract`,
          taskId
        );
      }

      const contract = this.stateStore.getContract(
        currentRun.contractBinding.contractId,
        currentRun.contractBinding.version
      );
      if (!contract || contract.lifecycle.status !== "ACTIVE") {
        return assembleResult(
          "CONTRACT_REVOKED",
          `Bound Mission Contract '${currentRun.contractBinding.contractId}' is not ACTIVE`,
          taskId
        );
      }

      // ----------------------------------------------------------------------
      // Begin Step Execution
      // ----------------------------------------------------------------------
      stepCount++;
      const stepStartTime = this.clock.now().getTime();
      const stepTimestamp = this.clock.nowIso();
      let availableTools: readonly ToolDefinition[] = this.toolRegistry.listTools();
      let filteredToolNames: readonly string[] = [];
      const activeTenantId = contract.spec.policy.tenantId ?? "tenant-default";

      // Lifecycle Memory Hook 1: Record immutable task context on run initialization
      if (this.scopedMemory && !hasRecordedTaskMemory) {
        hasRecordedTaskMemory = true;
        try {
          const taskRecord = this.stateStore.getTask(taskId);
          if (taskRecord) {
            const safeTaskSummary = JSON.stringify(
              redactSensitiveData({
                taskId,
                runId,
                title: taskRecord.title,
                description: taskRecord.description,
              })
            );
            this.scopedMemory.recordEntry(
              activeTenantId,
              taskId,
              "CURRENT_TASK_CONTEXT",
              "runtime.task_init",
              safeTaskSummary,
              {
                runId,
                agentId: workerId,
                isModelGenerated: false,
                isIndependentlyVerified: false,
                idempotencyKey: `m42:task_init:${runId}`,
                nowIso: stepTimestamp,
              }
            );
          }
        } catch {
          // Best-effort non-fatal init record; Truth Firewall still throws on invalid verified claims
        }
      }

      // Step A: Build Authoritative ContextSnapshot
      let contextSnapshot: ContextSnapshot;
      try {
        const candidates = await this.contextSource.gatherCandidateObservations(runId);
        let memoryObs: Observation | null = null;
        if (this.scopedMemory) {
          try {
            const rawRole = (this.stateStore.getTask(taskId)?.inputPayload as { role?: unknown } | null | undefined)?.role;
            const role: "RESEARCHER" | "CODER" | "TESTER" | "REVIEWER" =
              rawRole === "RESEARCHER" || rawRole === "CODER" || rawRole === "TESTER" || rawRole === "REVIEWER"
                ? rawRole
                : "CODER";
            const compiled = this.scopedMemory.compileContextForPrompt(activeTenantId, taskId, {
              maxTokens: Math.min(2048, params.contextBudget?.maxEstimatedTokens ?? 2048),
              role,
              runId,
              includeProjectKnowledge: true,
              includeAgentWorkingContext: true,
              nowIso: stepTimestamp,
            });
            if (compiled.compiledPrompt.trim().length > 0) {
              const memContent = redactSensitiveData({
                memorySummary: compiled.compiledPrompt.slice(0, 4096),
                verifiedFactCount: compiled.verifiedCount,
                unverifiedObservationCount: compiled.unverifiedObservationCount,
                modelHypothesisCount: compiled.modelHypothesisCount,
                truthFirewallEnforced: true,
              }) as Record<string, unknown>;
              const memBytes = estimateBytes(memContent);
              const candidateMemObs: Observation = {
                observationId: `obs-scoped-memory-step-${stepCount}`,
                category: "MISSION_CONTEXT",
                provenance: {
                  entityKind: "Run",
                  entityId: runId,
                  runId,
                  sequenceNumber: stepCount,
                  timestamp: stepTimestamp,
                  isAuthoritativeRuntimeFact: false,
                },
                freshness: "CURRENT",
                priority: 75,
                content: memContent,
                contentHash: computeObservationContentHash(memContent),
                estimatedBytes: memBytes,
                estimatedTokens: estimateTokens(memBytes),
                isMandatory: false,
              };
              validateObservation(candidateMemObs);
              memoryObs = candidateMemObs;
            }
          } catch {
            memoryObs = null;
          }
        }
        const effectiveCandidates = [
          ...candidates,
          ...(memoryObs ? [memoryObs] : []),
          ...(pendingProposalRejectionObservation ? [pendingProposalRejectionObservation] : []),
          ...(pendingProgressAdvisoryObservation ? [pendingProgressAdvisoryObservation] : []),
          ...(pendingTestFeedbackObservation ? [pendingTestFeedbackObservation] : []),
          ...(pendingActionRecoveryObservation ? [pendingActionRecoveryObservation] : []),
        ];
        pendingProposalRejectionObservation = null;
        pendingProgressAdvisoryObservation = null;
        pendingTestFeedbackObservation = null;
        pendingActionRecoveryObservation = null;

        contextSnapshot = ContextEngine.build({
          runId,
          taskId,
          candidates: effectiveCandidates,
          budget: params.contextBudget,
          createdAt: stepTimestamp,
        });
        lastContextSnapshot = contextSnapshot;
      } catch (err: unknown) {
        if (err instanceof ContextBudgetExceededError) {
          return assembleResult("CONTEXT_BUDGET_EXCEEDED", err.message, taskId);
        }
        throw err;
      }

      // Step B: Query Agent Brain (Untrusted Model Output)
      let brainResult: AgentBrainResult;
      const inferenceStartedAt = this.clock.nowIso();
      const inferenceStartMs = this.clock.now().getTime();
      try {
        if (effectiveDynamicToolFiltering) {
          const targetPath = this.resolveTargetFilePath(contextSnapshot);
          if (targetPath) {
            availableTools = this.contextResidencyTracker.filterEligibleTools(
              availableTools,
              targetPath,
              contextSnapshot
            );
            const eligibleSet = new Set(availableTools.map((t) => t.name));
            filteredToolNames = this.toolRegistry
              .listTools()
              .map((t) => t.name)
              .filter((n) => !eligibleSet.has(n));
          }
        }

        const brainRequest: AgentBrainRequest = {
          runId,
          contextSnapshot,
          availableTools,
          sequenceNumber: stepCount,
          abortSignal: params.abortSignal,
        };
        brainResult = await this.agentBrain.proposeAction(brainRequest);

        // Enforce active-lease fencing before committing telemetry, proposals, checkpoints, or completion
        const postBrainLeaseError = hasActiveLeaseAuthority();
        if (postBrainLeaseError !== null) {
          return assembleResult("LEASE_LOST", postBrainLeaseError, taskId);
        }

          // Persist successful/response inference telemetry event
          const inferenceCompletedAt = this.clock.nowIso();
          const inferenceWallClockMs = this.clock.now().getTime() - inferenceStartMs;
          const meta = brainResult.modelMetadata;
          const outcome: ModelInferenceOutcome =
            brainResult.finishReason === "ERROR"
              ? (brainResult.error?.toLowerCase().includes("json") || brainResult.error?.toLowerCase().includes("schema")
                  ? "INVALID_RESPONSE"
                  : "ERROR")
              : "SUCCESS";

          const telemetryPayload: ModelInferenceTelemetryPayload = {
            runId,
            taskId,
            stepNumber: stepCount,
            workerId,
            leaseId,
            requestId: meta?.requestId ?? crypto.randomUUID(),
            model: meta?.modelName ?? (this.agentBrain as any)?.model ?? "unknown",
            provider: meta?.providerName ?? "ollama",
            outcome,
            startedAt: inferenceStartedAt,
            completedAt: inferenceCompletedAt,
            wallClockDurationMs: inferenceWallClockMs,
            totalDurationNs: meta?.totalDurationNs ?? null,
            loadDurationNs: meta?.loadDurationNs ?? null,
            promptEvalDurationNs: meta?.promptEvalDurationNs ?? null,
            evalDurationNs: meta?.evalDurationNs ?? null,
            promptEvalCount: meta?.promptEvalCount ?? null,
            evalCount: meta?.evalCount ?? null,
            doneReason: meta?.doneReason ?? null,
            finishReason: meta?.finishReason ?? null,
            modelParameters: meta?.modelParameters,
            error: brainResult.finishReason === "ERROR" ? {
              message: brainResult.error,
            } : null,
          };

          const telemetryEvent: ModelInferenceTelemetryEvent = {
            eventId: crypto.randomUUID(),
            runId,
            timestamp: inferenceCompletedAt,
            eventType: "model.inference.telemetry",
            schemaVersion: 1,
            producer: "application.agent_step_controller",
            payload: telemetryPayload,
          };

          if (hasActiveLeaseAuthority() === null) {
            try {
              this.stateStore.transaction((tx) => {
                tx.appendEvent(telemetryEvent, `inference-telemetry:${telemetryPayload.requestId}`);
              });
            } catch {
              // Failure isolation: telemetry failure must not disrupt step execution
            }
          }
        } catch (err: unknown) {
          // Persist failure inference telemetry event
          const inferenceCompletedAt = this.clock.nowIso();
          const inferenceWallClockMs = this.clock.now().getTime() - inferenceStartMs;
          let outcome: ModelInferenceOutcome = "ERROR";
          let errorCode = "UNKNOWN_ERROR";
          let reqId: string = crypto.randomUUID();

          if (err instanceof ModelRequestTimeoutError) {
            outcome = "TIMEOUT";
            errorCode = "MODEL_REQUEST_TIMEOUT";
            if (err.requestId) reqId = err.requestId;
          } else if (err instanceof ModelRequestCancelledError) {
            outcome = "CANCELLED";
            errorCode = "MODEL_REQUEST_CANCELLED";
            if (err.requestId) reqId = err.requestId;
          } else if (err instanceof ModelProviderUnavailableError) {
            outcome = "PROVIDER_UNAVAILABLE";
            errorCode = "MODEL_PROVIDER_UNAVAILABLE";
            if (err.requestId) reqId = err.requestId;
          } else if (err instanceof ModelResponseInvalidError) {
            outcome = "INVALID_RESPONSE";
            errorCode = "MODEL_RESPONSE_INVALID";
            if (err.requestId) reqId = err.requestId;
          } else if (err instanceof ModelProviderError) {
            errorCode = err.code;
            if (err.requestId) reqId = err.requestId;
          }

          const failurePayload: ModelInferenceTelemetryPayload = {
            runId,
            taskId,
            stepNumber: stepCount,
            workerId,
            leaseId,
            requestId: reqId,
            model: (this.agentBrain as any)?.model ?? "unknown",
            provider: (this.agentBrain as any)?.modelProvider?.providerName ?? "ollama",
            outcome,
            startedAt: inferenceStartedAt,
            completedAt: inferenceCompletedAt,
            wallClockDurationMs: inferenceWallClockMs,
            totalDurationNs: null,
            loadDurationNs: null,
            promptEvalDurationNs: null,
            evalDurationNs: null,
            promptEvalCount: null,
            evalCount: null,
            doneReason: null,
            finishReason: null,
            error: {
              code: errorCode,
              message: err instanceof Error ? err.message : String(err),
            },
          };

          const failureEvent: ModelInferenceTelemetryEvent = {
            eventId: crypto.randomUUID(),
            runId,
            timestamp: inferenceCompletedAt,
            eventType: "model.inference.telemetry",
            schemaVersion: 1,
            producer: "application.agent_step_controller",
            payload: failurePayload,
          };

          const catchLeaseError = hasActiveLeaseAuthority();
          if (catchLeaseError !== null) {
            return assembleResult("LEASE_LOST", catchLeaseError, taskId);
          }

          try {
            this.stateStore.transaction((tx) => {
              tx.appendEvent(failureEvent, `inference-telemetry:${reqId}`);
            });
          } catch {
            // Failure isolation
          }

          transcript.push(
            Object.freeze({
              stepNumber: stepCount,
              contextSnapshotId: contextSnapshot.snapshotId,
              contextHash: contextSnapshot.contextHash,
              contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
              contextBytes: contextSnapshot.totalBytes,
              contextObservationsCount: contextSnapshot.observations.length,
              proposalValid: false,
              durationMs: this.clock.now().getTime() - stepStartTime,
              timestamp: stepTimestamp,
            })
          );
          return assembleResult(
            "BRAIN_FAILURE",
            `Agent Brain invocation failed: ${err instanceof Error ? err.message : String(err)}`,
            taskId
          );
        }

      // Step C: Inspect Brain Termination Signals
      if (brainResult.finishReason === "ERROR") {
        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            finishReason: "ERROR",
            proposalValid: false,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );
        return assembleResult(
          "BRAIN_FAILURE",
          `Agent Brain reported error: ${brainResult.error ?? "unknown error"}`,
          taskId
        );
      }

      if (brainResult.finishReason === "CONTEXT_LIMIT") {
        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            finishReason: "CONTEXT_LIMIT",
            proposalValid: false,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );
        return assembleResult(
          "CONTEXT_BUDGET_EXCEEDED",
          "Agent Brain reached context limit ceiling",
          taskId
        );
      }

      if (brainResult.finishReason === "GOAL_REACHED") {
        // Authoritative Physical Verification Completion Gate (Phase 13B / Step 11)
        // MODEL_GOAL_REACHED != RUN_COMPLETED
        // isGoalReached: true is strictly an untrusted model proposal.
        const completionContext: CompletionEvaluationContext = {
          cleanRoomVerifierAvailable: Boolean(this.cleanRoomVerifier),
          workspaceAvailable: Boolean(params.workspace),
          leaseFencing: { workerId, leaseId },
        };

        // Milestone 2.28 Phase 5 Step 11: Mandatory System-Owned Governed Verification Stage
        // System-owned verification execution runs on the completion path before authoritative gate evaluation.
        const isVerificationStageEnabled =
          params.enableGovernedVerificationStage ??
          this.enableGovernedVerificationStage ??
          true;

        if (isVerificationStageEnabled) {
          const stageResult = await this.executeGovernedVerificationStage({
            runId,
            taskId,
            contract,
            workerId,
            leaseId,
            workspace: params.workspace,
            abortSignal: params.abortSignal,
            effectiveBudget,
            currentAgentActionCount: agentActionCount,
            currentVerificationActionCount: verificationActionCount,
            consecutiveFailures,
            replayBlockCount,
            stepCount,
            startTime,
            stepStartTime,
            stepTimestamp,
            contextSnapshot,
            transcript,
            assembleResult: (reason, message) => assembleResult(reason, message, taskId),
          });

          agentActionCount = stageResult.updatedAgentActionCount;
          verificationActionCount = stageResult.updatedVerificationActionCount;
          if (!stageResult.terminalResult && stageResult.lastVerificationActionId) {
            persistLoopCheckpoint(
              stageResult.lastVerificationActionId,
              stageResult.lastVerificationAttemptNumber ?? null
            );
          }
          consecutiveFailures = stageResult.updatedConsecutiveFailures;
          replayBlockCount = stageResult.updatedReplayBlockCount;
          if (stageResult.replayFeedback) {
            pendingActionRecoveryObservation = stageResult.replayFeedback;
          }

          if (stageResult.terminalResult) {
            return stageResult.terminalResult;
          }
        }

        let verificationEvaluation = this.evaluateCompletionVerification(
          runId,
          contract,
          completionContext
        );
        if (verificationEvaluation.leaseLost) {
          return assembleResult(
            "LEASE_LOST",
            verificationEvaluation.failureReason ?? `Lease lost during completion verification`,
            taskId
          );
        }

        // Phase 14: Independent Clean-Room Verification (fail closed: a missing verifier/workspace is
        // reported by the evaluator as unverifiable; a verifier that cannot run never authorizes completion)
        const cleanRoomSpecObj = (contract.spec.verificationSpecs ?? []).find(
          (s) => s.ruleKind === "CLEAN_ROOM_DUAL_GATE"
        );
        if (
          verificationEvaluation.cleanRoomPending &&
          cleanRoomSpecObj &&
          this.cleanRoomVerifier &&
          params.workspace
        ) {
          const cleanSpec = cleanRoomSpecObj.expectedValue as CleanRoomVerificationSpec;
          let cleanRoomOutcome: CleanRoomVerificationOutcome | undefined;
          let cleanRoomError: string | undefined;
          try {
            cleanRoomOutcome = await this.cleanRoomVerifier.verifyCandidatePatch({
              runId,
              taskId,
              workerId,
              leaseId,
              contract,
              spec: cleanSpec,
              agentWorkspace: params.workspace,
              abortSignal: params.abortSignal,
            });
          } catch (err: unknown) {
            cleanRoomError = err instanceof Error ? err.name : "UnknownError";
          }

          if (!cleanRoomOutcome) {
            verificationEvaluation = {
              verified: false,
              rejectionCode: "CLEAN_ROOM_NOT_VERIFIED",
              failureReason: `Independent clean-room verification could not be evaluated (${cleanRoomError ?? "no outcome"})`,
              specResults: verificationEvaluation.specResults,
              requirementsSummary: {
                ...(verificationEvaluation.requirementsSummary ?? {}),
                "clean-room verification": "not evaluated",
              },
              outstandingRequirements: [
                ...(verificationEvaluation.outstandingRequirements ?? []),
                "clean-room proof: NOT_EVALUATED",
              ],
            };
          } else {
            if (cleanRoomOutcome.replayBlock) {
              // Clean-room test command was refused by the replay gate: verification could not run.
              replayBlockCount++;
              if (replayBlockCount >= 2) {
                return assembleResult(
                  "POLICY_DENIED",
                  `Repeated clean-room verification blocked by an uncertain prior execution (${replayBlockCount} replay blocks in this run)`,
                  taskId
                );
              }
              pendingActionRecoveryObservation = this.buildReplayBlockFeedback({
                details: cleanRoomOutcome.replayBlock,
                runId,
                entityId: cleanRoomOutcome.replayBlock.priorActionId ?? `clean-room-step-${stepCount}`,
                stepCount,
                source: "CLEAN_ROOM_VERIFICATION",
              });
            }

            if (cleanRoomOutcome.status !== "VERIFIED") {
              verificationEvaluation = {
                verified: false,
                rejectionCode: "CLEAN_ROOM_NOT_VERIFIED",
                failureReason: `Independent clean-room proof failed: ${cleanRoomOutcome.message}`,
                specResults: [cleanRoomOutcome.verificationResult],
                requirementsSummary: {
                  ...(verificationEvaluation.requirementsSummary ?? {}),
                  "clean-room verification": "failed",
                },
                outstandingRequirements: [
                  ...(verificationEvaluation.outstandingRequirements ?? []),
                  `clean-room proof: ${cleanRoomOutcome.failureReasonCode ?? "FAILED"}`,
                ],
              };
            } else {
              // Re-evaluate with the independent outcome so the clean-room requirement is satisfied by evidence.
              verificationEvaluation = this.evaluateCompletionVerification(runId, contract, {
                ...completionContext,
                cleanRoomOutcome,
              });
              if (verificationEvaluation.leaseLost) {
                return assembleResult(
                  "LEASE_LOST",
                  verificationEvaluation.failureReason ?? `Lease lost during clean-room completion verification`,
                  taskId
                );
              }
            }
          }
        }

        // Terminal: no model action can satisfy this contract (no specs, unsupported rule, missing verifier or
        // workspace). Do not keep asking the model to solve a requirement it cannot meet.
        if (!verificationEvaluation.verified && verificationEvaluation.unverifiable) {
          const unvLeaseError = hasActiveLeaseAuthority();
          if (unvLeaseError !== null) {
            return assembleResult("LEASE_LOST", unvLeaseError, taskId);
          }
          const rejectionTimestamp = this.clock.nowIso();
          const rejectionCode = verificationEvaluation.rejectionCode ?? "NO_VERIFICATION_SPECS";
          this.stateStore.transaction((tx) => {
            tx.appendEvent({
              eventId: crypto.randomUUID(),
              runId,
              timestamp: rejectionTimestamp,
              eventType: "verification.rejected",
              schemaVersion: 1,
              producer: "application.agent_step_controller",
              payload: {
                status: "COMPLETION_UNVERIFIABLE",
                reason: rejectionCode,
                message: "Completion cannot be authorized: the runtime has no way to verify this Mission Contract.",
                requirements: verificationEvaluation.requirementsSummary ?? {},
                outstandingRequirements: verificationEvaluation.outstandingRequirements ?? [],
                rejectedAt: rejectionTimestamp,
              },
            });
          });
          transcript.push(
            Object.freeze({
              stepNumber: stepCount,
              contextSnapshotId: contextSnapshot.snapshotId,
              contextHash: contextSnapshot.contextHash,
              contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
              contextBytes: contextSnapshot.totalBytes,
              contextObservationsCount: contextSnapshot.observations.length,
              finishReason: "GOAL_REACHED",
              proposalValid: false,
              proposalRejectionReason: "UNVERIFIED_COMPLETION_CLAIM",
              proposalRejectionMessage: `Goal reached claim cannot be verified: ${rejectionCode}`,
              durationMs: this.clock.now().getTime() - stepStartTime,
              timestamp: stepTimestamp,
            })
          );
          return assembleResult(
            "COMPLETION_UNVERIFIABLE",
            `Completion cannot be authorized (${rejectionCode}): ${verificationEvaluation.failureReason ?? "no verifiable requirement"}`,
            taskId
          );
        }

        if (!verificationEvaluation.verified) {
          const rejLeaseError = hasActiveLeaseAuthority();
          if (rejLeaseError !== null) {
            return assembleResult("LEASE_LOST", rejLeaseError, taskId);
          }
          proposalRejections++;
          const rejectionTimestamp = this.clock.nowIso();

          // Phase 13C: Persist authoritative completion rejection observation into the durable event stream
          this.stateStore.transaction((tx) => {
            tx.appendEvent({
              eventId: crypto.randomUUID(),
              runId,
              timestamp: rejectionTimestamp,
              eventType: "verification.rejected",
              schemaVersion: 1,
              producer: "application.agent_step_controller",
              payload: {
                status: "COMPLETION_REJECTED",
                reason: "UNVERIFIED_COMPLETION_CLAIM",
                rejectionCode: this.classifyCompletionRejection(verificationEvaluation),
                message:
                  "Required verification evidence is missing. The task is not complete. Continue using the available governed tools.",
                requirements: verificationEvaluation.requirementsSummary ?? {},
                outstandingRequirements:
                  verificationEvaluation.outstandingRequirements ?? [],
                rejectedAt: rejectionTimestamp,
              },
            });
          });

          transcript.push(
            Object.freeze({
              stepNumber: stepCount,
              contextSnapshotId: contextSnapshot.snapshotId,
              contextHash: contextSnapshot.contextHash,
              contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
              contextBytes: contextSnapshot.totalBytes,
              contextObservationsCount: contextSnapshot.observations.length,
              finishReason: "GOAL_REACHED",
              proposalValid: false,
              proposalRejectionReason: "UNVERIFIED_COMPLETION_CLAIM",
              proposalRejectionMessage: `Goal reached claim rejected: ${verificationEvaluation.failureReason}`,
              durationMs: this.clock.now().getTime() - stepStartTime,
              timestamp: stepTimestamp,
            })
          );

          // Goal claim rejected: bounded next model step if budget permits
          continue;
        }

        const preCompleteLeaseError = hasActiveLeaseAuthority();
        if (preCompleteLeaseError !== null) {
          return assembleResult("LEASE_LOST", preCompleteLeaseError, taskId);
        }

        // Explicit operator opt-in only: record that completion was authorized WITHOUT verification specs.
        if (
          this.allowUnverifiedCompletion &&
          (!contract.spec.verificationSpecs || contract.spec.verificationSpecs.length === 0)
        ) {
          const authorizedAt = this.clock.nowIso();
          this.stateStore.transaction((tx) => {
            tx.appendEvent({
              eventId: crypto.randomUUID(),
              runId,
              timestamp: authorizedAt,
              eventType: "verification.unverified_completion_authorized",
              schemaVersion: 1,
              producer: "application.agent_step_controller",
              payload: {
                status: "UNVERIFIED_COMPLETION_AUTHORIZED",
                reason: "OPERATOR_OPT_IN_NO_VERIFICATION_SPECS",
                authorizedAt,
              },
            });
          });
        }

        // Verified goal reached: physical verification invariant satisfied
        const taskForVerify = this.stateStore.getTask(taskId);
        const taskInputForVerify = (taskForVerify?.inputPayload as Record<string, unknown> | null | undefined) ?? undefined;
        let productionProofHash: string | undefined;
        if (this.productionVerifier && params.workspace && taskInputForVerify?.productionVerify === true) {
          const pv = await this.productionVerifier.verify({
            workspacePath: params.workspace.hostPath,
            ...(taskInputForVerify.buildCommand && typeof taskInputForVerify.buildCommand === "object"
              ? { buildCommand: taskInputForVerify.buildCommand as { cmd: string; args: string[] } }
              : {}),
            ...(taskInputForVerify.testCommand && typeof taskInputForVerify.testCommand === "object"
              ? { testCommand: taskInputForVerify.testCommand as { cmd: string; args: string[] } }
              : {}),
          });
          const postPvLeaseError = hasActiveLeaseAuthority();
          if (postPvLeaseError !== null) {
            return assembleResult("LEASE_LOST", postPvLeaseError, taskId);
          }
          productionProofHash = pv.proofHash;
          this.stateStore.transaction((tx) => {
            tx.appendEvent({
              eventId: crypto.randomUUID(),
              runId,
              timestamp: this.clock.nowIso(),
              eventType: pv.verified ? "verification.completed" : "verification.rejected",
              schemaVersion: 1,
              producer: "verification.production_verifier",
              payload: {
                status: pv.verified ? "VERIFIED" : "FAILED",
                proofHash: pv.proofHash,
                stages: pv.stages,
                ...(pv.failureReason ? { reason: pv.failureReason } : {}),
              },
            });
          });
          if (!pv.verified) {
            this.telemetry?.recordRepairLifecycle({ outcome: "failed" });
            if (this.scopedMemory) {
              try {
                this.scopedMemory.recordEntry(
                  activeTenantId,
                  taskId,
                  "DURABLE_TASK_HISTORY",
                  "verification.production_verifier",
                  JSON.stringify(redactSensitiveData({ verified: false, proofHash: pv.proofHash, failureReason: pv.failureReason })),
                  { runId, isModelGenerated: false, isIndependentlyVerified: false, nowIso: this.clock.nowIso() }
                );
              } catch { /* non-fatal */ }
            }
            return assembleResult(
              "REPAIR_EXHAUSTED",
              pv.failureReason ?? "Independent ProductionVerifier failed verification stages",
              taskId
            );
          }
        }

        if (hasObservedRepairFailure && repairState) {
          this.boundedRepairLoop.concludeVerification(repairState, 0);
          this.telemetry?.recordRepairLifecycle({ outcome: "verified" });
        }

        if (this.scopedMemory) {
          try {
            const verifiedSummary = JSON.stringify(
              redactSensitiveData({
                runId,
                taskId,
                verifiedAt: stepTimestamp,
                specIds: verificationEvaluation.specResults.map((s) => s.specId),
                ...(productionProofHash ? { productionProofHash } : {}),
              })
            );
            this.scopedMemory.recordEntry(
              activeTenantId,
              taskId,
              "VERIFIED_EVIDENCE",
              "verifier.deterministic",
              verifiedSummary,
              {
                runId,
                agentId: workerId,
                isModelGenerated: false,
                isIndependentlyVerified: true,
                idempotencyKey: `m42:verified:${runId}`,
                nowIso: stepTimestamp,
              }
            );
          } catch {
            // Best-effort durable verification summary
          }
        }

        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            finishReason: "GOAL_REACHED",
            proposalValid: false,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );

        return assembleResult(
          "COMPLETED",
          "Agent Brain concluded step loop with verified completion (GOAL_REACHED)",
          taskId
        );
      }

      if (!brainResult.proposal) {
        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            finishReason: brainResult.finishReason,
            proposalValid: false,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );

        return assembleResult(
          "NO_ACTION",
          `Agent Brain produced no action proposal (${brainResult.finishReason})`,
          taskId
        );
      }

      // Re-verify contract active status before proposal validation
      const activeContract = this.stateStore.getContract(
        currentRun.contractBinding.contractId,
        currentRun.contractBinding.version
      );
      if (!activeContract || activeContract.lifecycle.status !== "ACTIVE") {
        return assembleResult(
          "CONTRACT_REVOKED",
          `Bound Mission Contract '${currentRun.contractBinding.contractId}' is not ACTIVE`,
          taskId
        );
      }

      // Step D: Validate ActionProposal (Pipeline)
      const validationResult = this.proposalValidator.validate(brainResult.proposal, {
        runId,
        contextSnapshot,
        workerId,
        leaseId,
        run: currentRun,
        contract: activeContract,
        workspaceHostPath: params.workspace?.hostPath,
        fileContentReader: (relPath: string) => {
          if (!params.workspace?.hostPath) return null;
          try {
            const editor = new LineAnchoredEditor();
            const safePath = editor.resolveSafePath(relPath, params.workspace.hostPath);
            if (fsSync.existsSync(safePath) && !fsSync.lstatSync(safePath).isDirectory()) {
              return fsSync.readFileSync(safePath, "utf8");
            }
          } catch {
            return null;
          }
          return null;
        },
        failedAnchorChecker: (relPath: string, searchAnchor: string) =>
          this.failedAnchorTracker.isFailedAnchor(relPath, searchAnchor),
        duplicateProposalChecker: (toolName: string, inputPayload: unknown) => {
          const record = this.duplicateProposalDetector.getDuplicateRecord(toolName, inputPayload);
          if (record) {
            return {
              isDuplicate: true,
              priorStep: record.stepNumber,
              priorReason: record.rejectionReason,
            };
          }
          return false;
        },
        ineffectiveMutationChecker: (toolName: string, inputPayload: unknown, targetPath?: string) => {
          if (toolName !== "edit_file" && toolName !== "write_file") {
            return false;
          }
          if (!targetPath || !params.workspace?.hostPath) {
            return false;
          }
          let currentSourceHash: string | undefined;
          try {
            const editor = new LineAnchoredEditor();
            const safePath = editor.resolveSafePath(targetPath, params.workspace.hostPath);
            if (fsSync.existsSync(safePath)) {
              const raw = fsSync.readFileSync(safePath, "utf-8");
              currentSourceHash = crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
            }
          } catch {
            return false;
          }

          const record = this.duplicateProposalDetector.getIneffectiveMutationRecord(
            toolName,
            inputPayload,
            currentSourceHash,
            this.duplicateProposalDetector.getWorkspaceMutationVersion()
          );
          if (record) {
            return {
              isIneffective: true,
              priorStep: record.stepNumber,
              reason: `Identical mutation was executed at step ${record.stepNumber} and failed intermediate verification (${record.verificationClassification})`,
            };
          }
          return false;
        },
        postPassMutationChecker: (toolName: string, targetPath?: string) =>
          effectiveBudget.enablePostPassVerificationLatch !== false
            ? this.postPassLatch.isMutationProhibited(toolName, targetPath)
            : false,
      });

      if (!validationResult.valid) {
        proposalRejections++;
        const rejectionTimestamp = this.clock.nowIso();

        const proposalToolName = (brainResult.proposal as any)?.toolName;
        const proposalInputPayload = (brainResult.proposal as any)?.inputPayload;

        this.duplicateProposalDetector.recordRejection(
          proposalToolName ?? "unknown",
          proposalInputPayload,
          validationResult.reason,
          stepCount,
          rejectionTimestamp
        );

        // Phase 43: Construct typed, bounded rejection feedback observation for the immediately next model step
        try {
          const rawMessage = validationResult.message ?? "";
          let boundedMessage: string | undefined = undefined;
          if (rawMessage.length > 0) {
            boundedMessage =
              rawMessage.length > MAX_REJECTION_FEEDBACK_CHARS
                ? rawMessage.slice(0, MAX_REJECTION_FEEDBACK_CHARS) + " [TRUNCATED]"
                : rawMessage;
            boundedMessage = sanitizeRejectionMessage(boundedMessage);
          }

          const actionableGuidance = deriveActionableValidationGuidance({
            toolName: proposalToolName,
            rejectionReason: validationResult.reason,
            inputPayload: proposalInputPayload,
            validatorMessage: rawMessage,
          });

          const sanitizedGuidance = actionableGuidance
            ? sanitizeRejectionMessage(actionableGuidance)
            : undefined;

          const feedbackExplanation = sanitizedGuidance ?? boundedMessage;

          const feedbackContent: Record<string, unknown> = {
            feedbackKind: "PROPOSAL_VALIDATION_FAILED",
            stepNumber: stepCount,
            rejectionReason: validationResult.reason,
            ...(feedbackExplanation !== undefined ? { explanation: feedbackExplanation } : {}),
            ...((brainResult.proposal as any)?.proposalId
              ? { rejectedProposalId: (brainResult.proposal as any).proposalId }
              : {}),
            ...(proposalToolName ? { rejectedToolName: proposalToolName } : {}),
          };

          const redactedContent = redactSensitiveData(feedbackContent) as Record<string, unknown>;
          const feedbackBytes = estimateBytes(redactedContent);

          const feedbackObs: Observation = {
            observationId: `obs-rejection-step-${stepCount}`,
            category: "TOOL_ERROR",
            provenance: {
              entityKind: "Action",
              entityId: (brainResult.proposal as any)?.proposalId ?? `step-${stepCount}`,
              runId,
              sequenceNumber: stepCount,
              timestamp: rejectionTimestamp,
              isAuthoritativeRuntimeFact: true,
            },
            freshness: "CURRENT",
            priority: 85,
            content: redactedContent,
            contentHash: computeObservationContentHash(redactedContent),
            estimatedBytes: feedbackBytes,
            estimatedTokens: estimateTokens(feedbackBytes),
            isMandatory: true,
          };
          validateObservation(feedbackObs);
          pendingProposalRejectionObservation = feedbackObs;
        } catch {
          // Failure to construct feedback must fail safely without authorizing invalid proposal
          pendingProposalRejectionObservation = null;
        }

        // Persist durable rejection event to stateStore if available
        try {
          this.stateStore.transaction((tx) => {
            tx.appendEvent({
              eventId: crypto.randomUUID(),
              runId,
              timestamp: rejectionTimestamp,
              eventType: "proposal.rejected",
              schemaVersion: 1,
              producer: "application.agent_step_controller",
              payload: {
                proposalId: (brainResult.proposal as any)?.proposalId,
                toolName: (brainResult.proposal as any)?.toolName,
                rejectionReason: validationResult.reason,
                explanation: validationResult.message,
                stepNumber: stepCount,
                rejectedAt: rejectionTimestamp,
              },
            });
          });
        } catch {
          // Failure to persist must fail safely
        }

        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            proposalId: (brainResult.proposal as any)?.proposalId,
            toolName: (brainResult.proposal as any)?.toolName,
            inputPayload: (brainResult.proposal as any)?.inputPayload,
            rationale: (brainResult.proposal as any)?.rationale,
            finishReason: brainResult.finishReason,
            proposalValid: false,
            proposalRejectionReason: validationResult.reason,
            proposalRejectionMessage: validationResult.message,
            ...(effectiveDynamicToolFiltering
              ? {
                  eligibleTools: availableTools.map((t) => t.name),
                  filteredTools: filteredToolNames,
                }
              : {}),
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );

        // Persist checkpoint at safe proposal rejection boundary
        persistLoopCheckpoint();

        // Rejection does not execute physical actions. Loop continues if budget permits.
        continue;
      }

      // Step D.2: Evaluate Validated Proposal via Governed Reflex Interceptor
      const rawReflexContext: ReflexContext = {
        runId,
        taskId,
        stepNumber: stepCount,
        taskDescription: activeContract.spec.taskId,
        failureCount: consecutiveFailures,
        recentActionHistory: transcript
          .filter((t) => t.toolName)
          .slice(-10)
          .map((t) => ({
            toolName: t.toolName!,
            status: t.actionStatus ?? "UNKNOWN",
            sequenceNumber: t.stepNumber,
            inputHash: t.inputHash,
            failureReason: t.actionError ? String(t.actionError) : undefined,
          })),
        workspacePath: params.workspace?.hostPath,
        resourceUsage: {
          elapsedWallClockMs: elapsedMs,
          actionsExecuted: agentActionCount + verificationActionCount,
          stepsExecuted: stepCount,
        },
      };
      const reflexContextHash = computeReflexContextHash(rawReflexContext);
      const reflexContext: ReflexContext = Object.freeze({
        ...rawReflexContext,
        contextHash: reflexContextHash,
      });

      let reflexDecisionResult;
      let reflexEvidence: ReflexEvidence | undefined = undefined;
      let reflexDurationMs: number | undefined = undefined;

      const reflexStartMonotonic = performance.now();
      try {
        const unvalidatedDecision = await this.reflex.evaluate(
          validationResult.proposal,
          reflexContext
        );
        reflexDurationMs = Math.max(0, Math.round(performance.now() - reflexStartMonotonic));
        reflexDecisionResult = validateReflexDecision(unvalidatedDecision);

        if (!(this.reflex instanceof NoopReflex)) {
          try {
            reflexEvidence = createReflexEvidence({
              runId,
              sequenceNumber: stepCount,
              proposal: validationResult.proposal,
              context: reflexContext,
              decision: reflexDecisionResult,
              reflexImplementation: (this.reflex as any).name ?? "RuleBasedReflex",
              ruleConfigurationHash: (this.reflex as any).activeConfigHash ?? "0".repeat(64),
              ruleConfig: (this.reflex as any).activeConfig,
              evaluatedAt: stepTimestamp,
            });
          } catch {
            // Defense-in-depth: do not crash reasoning loop if evidence construction fails
          }
        }
      } catch (err: unknown) {
        if (
          params.abortSignal?.aborted ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return assembleResult(
            "CANCELLED",
            "Execution loop cancelled via AbortSignal during Reflex evaluation",
            taskId
          );
        }

        const elapsedReflexMs = Math.max(0, Math.round(performance.now() - reflexStartMonotonic));
        proposalRejections++;

        // Construct bounded structured rejection feedback observation for subsequent turn
        const rawErrExplanation = err instanceof Error ? err.message : String(err);
        let boundedErrMsg: string | undefined = undefined;
        if (rawErrExplanation) {
          const sanitized = sanitizeRejectionMessage(rawErrExplanation);
          boundedErrMsg =
            sanitized.length > MAX_REJECTION_FEEDBACK_CHARS
              ? sanitized.slice(0, MAX_REJECTION_FEEDBACK_CHARS - 14) + " ...[TRUNCATED]"
              : sanitized;
        }
        try {
          const feedbackContent: Record<string, unknown> = {
            rejectionCategory: "REFLEX_ERROR",
            rejectionReason: "UNSUPPORTED_ACTION",
            ...(boundedErrMsg !== undefined ? { explanation: boundedErrMsg } : {}),
            rejectedProposalId: validationResult.proposal.proposalId,
            rejectedToolName: validationResult.proposal.toolName,
          };

          const redactedContent = redactSensitiveData(feedbackContent) as Record<string, unknown>;
          const feedbackBytes = estimateBytes(redactedContent);

          const feedbackObs: Observation = {
            observationId: `obs-reflex-error-step-${stepCount}`,
            category: "TOOL_ERROR",
            provenance: {
              entityKind: "Action",
              entityId: validationResult.proposal.proposalId ?? `step-${stepCount}`,
              runId,
              sequenceNumber: stepCount,
              timestamp: this.clock.now().toISOString(),
              isAuthoritativeRuntimeFact: true,
            },
            freshness: "CURRENT",
            priority: 85,
            content: redactedContent,
            contentHash: computeObservationContentHash(redactedContent),
            estimatedBytes: feedbackBytes,
            estimatedTokens: estimateTokens(feedbackBytes),
            isMandatory: true,
          };
          validateObservation(feedbackObs);
          pendingProposalRejectionObservation = feedbackObs;
        } catch {
          pendingProposalRejectionObservation = null;
        }

        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            proposalId: validationResult.proposal.proposalId,
            toolName: validationResult.proposal.toolName,
            inputPayload: validationResult.proposal.inputPayload,
            rationale: validationResult.proposal.rationale,
            finishReason: brainResult.finishReason,
            proposalValid: true,
            reflexReasonCode: "UNSUPPORTED_ACTION",
            reflexError: err instanceof Error ? err.message : String(err),
            reflexDurationMs: elapsedReflexMs,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );
        continue;
      }

      if (reflexDecisionResult.decision === "REJECT") {
        console.log("REFLEX REJECTED PROPOSAL:", validationResult.proposal.toolName, reflexDecisionResult.reasonCode, reflexDecisionResult.rationale);
        proposalRejections++;

        this.duplicateProposalDetector.recordRejection(
          validationResult.proposal.toolName,
          validationResult.proposal.inputPayload,
          reflexDecisionResult.reasonCode,
          stepCount,
          stepTimestamp
        );

        // Construct bounded structured rejection feedback observation for subsequent turn
        const rawExplanation = reflexDecisionResult.rationale ?? reflexDecisionResult.reasonCode;
        let boundedMessage: string | undefined = undefined;
        if (rawExplanation) {
          const sanitized = sanitizeRejectionMessage(rawExplanation);
          boundedMessage =
            sanitized.length > MAX_REJECTION_FEEDBACK_CHARS
              ? sanitized.slice(0, MAX_REJECTION_FEEDBACK_CHARS - 14) + " ...[TRUNCATED]"
              : sanitized;
        }
        try {
          const feedbackContent: Record<string, unknown> = {
            rejectionCategory: "REFLEX_REJECTION",
            rejectionReason: reflexDecisionResult.reasonCode,
            ...(boundedMessage !== undefined ? { explanation: boundedMessage } : {}),
            rejectedProposalId: validationResult.proposal.proposalId,
            rejectedToolName: validationResult.proposal.toolName,
          };

          const redactedContent = redactSensitiveData(feedbackContent) as Record<string, unknown>;
          const feedbackBytes = estimateBytes(redactedContent);

          const feedbackObs: Observation = {
            observationId: `obs-reflex-rejection-step-${stepCount}`,
            category: "TOOL_ERROR",
            provenance: {
              entityKind: "Action",
              entityId: validationResult.proposal.proposalId ?? `step-${stepCount}`,
              runId,
              sequenceNumber: stepCount,
              timestamp: this.clock.now().toISOString(),
              isAuthoritativeRuntimeFact: true,
            },
            freshness: "CURRENT",
            priority: 85,
            content: redactedContent,
            contentHash: computeObservationContentHash(redactedContent),
            estimatedBytes: feedbackBytes,
            estimatedTokens: estimateTokens(feedbackBytes),
            isMandatory: true,
          };
          validateObservation(feedbackObs);
          pendingProposalRejectionObservation = feedbackObs;
        } catch {
          pendingProposalRejectionObservation = null;
        }

        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            proposalId: validationResult.proposal.proposalId,
            toolName: validationResult.proposal.toolName,
            inputPayload: validationResult.proposal.inputPayload,
            rationale: validationResult.proposal.rationale,
            finishReason: brainResult.finishReason,
            proposalValid: true,
            reflexDecision: "REJECT",
            reflexReasonCode: reflexDecisionResult.reasonCode,
            reflexRationale: reflexDecisionResult.rationale,
            reflexEvidence,
            reflexDurationMs,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );
        continue;
      }

      if (reflexDecisionResult.decision === "DEFER") {
        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            proposalId: validationResult.proposal.proposalId,
            toolName: validationResult.proposal.toolName,
            inputPayload: validationResult.proposal.inputPayload,
            rationale: validationResult.proposal.rationale,
            finishReason: brainResult.finishReason,
            proposalValid: true,
            reflexDecision: "DEFER",
            reflexReasonCode: reflexDecisionResult.reasonCode,
            reflexRationale: reflexDecisionResult.rationale,
            reflexEvidence,
            reflexDurationMs,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );
        return assembleResult(
          "DEFERRED",
          `Reflex deferred proposal execution [${reflexDecisionResult.reasonCode}]: ${
            reflexDecisionResult.rationale ?? reflexDecisionResult.reasonCode
          }`,
          taskId
        );
      }

      // Step E: Create Authoritative Domain Action Aggregate
      const { action } = this.proposalValidator.createActionFromProposal(
        validationResult,
        currentRun,
        { now: stepTimestamp }
      );

      // Pre-Execution Fencing & Cancellation Check
      if (params.abortSignal?.aborted) {
        return assembleResult(
          "CANCELLED",
          `Aborted prior to executing Action '${action.actionId}'`,
          taskId
        );
      }

      // Pre-Execution Wall Clock Ceiling Check
      const preExecElapsedMs = this.clock.now().getTime() - startTime;
      if (preExecElapsedMs >= effectiveBudget.maxWallClockMs) {
        return assembleResult(
          "MAX_WALL_CLOCK",
          `Wall clock ceiling reached prior to executing Action '${action.actionId}' (${preExecElapsedMs}ms >= ${effectiveBudget.maxWallClockMs}ms)`,
          taskId
        );
      }

      // Pre-Execution Action Ceiling Check (Milestone 2.28 Phase 5 Step 12: separate agent vs verification budget)
      if (agentActionCount >= effectiveBudget.maxActions) {
        const isVerificationStageEnabled =
          params.enableGovernedVerificationStage ??
          this.enableGovernedVerificationStage ??
          true;

        if (isVerificationStageEnabled && (contract.spec.verificationSpecs?.length ?? 0) > 0) {
          const stageResult = await this.executeGovernedVerificationStage({
            runId,
            taskId,
            contract,
            workerId,
            leaseId,
            workspace: params.workspace,
            abortSignal: params.abortSignal,
            effectiveBudget,
            currentAgentActionCount: agentActionCount,
            currentVerificationActionCount: verificationActionCount,
            consecutiveFailures,
            replayBlockCount,
            stepCount,
            startTime,
            stepStartTime,
            stepTimestamp,
            contextSnapshot,
            transcript,
            assembleResult: (reason, message) => assembleResult(reason, message, taskId),
          });

          agentActionCount = stageResult.updatedAgentActionCount;
          verificationActionCount = stageResult.updatedVerificationActionCount;
          if (!stageResult.terminalResult && stageResult.lastVerificationActionId) {
            persistLoopCheckpoint(
              stageResult.lastVerificationActionId,
              stageResult.lastVerificationAttemptNumber ?? null
            );
          }
          consecutiveFailures = stageResult.updatedConsecutiveFailures;
          replayBlockCount = stageResult.updatedReplayBlockCount;

          if (stageResult.terminalResult) {
            return stageResult.terminalResult;
          }

          const completionContext: CompletionEvaluationContext = {
            cleanRoomVerifierAvailable: Boolean(this.cleanRoomVerifier),
            workspaceAvailable: Boolean(params.workspace),
            leaseFencing: { workerId, leaseId },
          };

          const verificationEvaluation = this.evaluateCompletionVerification(
            runId,
            contract,
            completionContext
          );
          if (verificationEvaluation.leaseLost) {
            return assembleResult(
              "LEASE_LOST",
              verificationEvaluation.failureReason ?? `Lease lost during completion verification`,
              taskId
            );
          }

          if (verificationEvaluation.verified) {
            transcript.push(
              Object.freeze({
                stepNumber: stepCount,
                contextSnapshotId: contextSnapshot.snapshotId,
                contextHash: contextSnapshot.contextHash,
                contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
                contextBytes: contextSnapshot.totalBytes,
                contextObservationsCount: contextSnapshot.observations.length,
                finishReason: "GOAL_REACHED",
                proposalValid: false,
                durationMs: this.clock.now().getTime() - stepStartTime,
                timestamp: stepTimestamp,
              })
            );

            return assembleResult(
              "COMPLETED",
              "Agent completed actions and mandatory verification succeeded",
              taskId
            );
          }
        }

        return assembleResult(
          "MAX_ACTIONS",
          `Maximum action execution ceiling reached prior to executing Action '${action.actionId}' (${agentActionCount} >= ${effectiveBudget.maxActions})`,
          taskId
        );
      }

      // Pre-Execution Lease Ownership & Expiration Check
      const preExecRun = this.stateStore.getRun(runId);
      if (!preExecRun || preExecRun.leaseId !== leaseId || preExecRun.currentWorkerId !== workerId) {
        return assembleResult(
          "LEASE_LOST",
          `Lease lost prior to executing Action '${action.actionId}'`,
          taskId
        );
      }
      if (preExecRun.leaseExpiresAt && this.clock.nowIso() >= preExecRun.leaseExpiresAt) {
        return assembleResult(
          "LEASE_LOST",
          `Lease expired prior to executing Action '${action.actionId}' (expired at '${preExecRun.leaseExpiresAt}')`,
          taskId
        );
      }

      // Pre-Execution Mission Contract Active Status Check
      const preExecContract = this.stateStore.getContract(
        currentRun.contractBinding.contractId,
        currentRun.contractBinding.version
      );
      if (!preExecContract || preExecContract.lifecycle.status !== "ACTIVE") {
        return assembleResult(
          "CONTRACT_REVOKED",
          `Mission Contract '${currentRun.contractBinding.contractId}' is no longer ACTIVE prior to executing Action '${action.actionId}'`,
          taskId
        );
      }

      // Pre-Execution Post-Pass Latch Protection Check (Defense-in-Depth)
      if (effectiveBudget.enablePostPassVerificationLatch !== false) {
        const actionTargetPath =
          typeof (action.inputPayload as any)?.path === "string"
            ? ((action.inputPayload as any).path as string)
            : undefined;
        const preExecLatchCheck = this.postPassLatch.isMutationProhibited(
          action.toolName,
          actionTargetPath
        );
        if (preExecLatchCheck.prohibited) {
          return assembleResult(
            "POLICY_DENIED",
            preExecLatchCheck.reason ?? "Target file is protected by the post-pass verification latch",
            taskId
          );
        }
      }

      // Step F: Execute Action via WorkerRuntime (Serial Execution)
      agentActionCount++;
      let actionResult: any;
      try {
        actionResult = await this.workerRuntime.executeAction({
          runId,
          actionId: action.actionId,
          sequenceNumber: action.sequenceNumber,
          toolName: action.toolName,
          inputPayload: action.inputPayload,
          leaseId,
          workspace: params.workspace,
          timeoutMs: contract.spec.resourceLimits.timeoutMs,
          maxOutputBytes: contract.spec.resourceLimits.maxOutputBytes,
          abortSignal: params.abortSignal,
        });
      } catch (err: unknown) {
        if (err instanceof LeaseLostError || err instanceof LeaseExpiredError) {
          return assembleResult(
            "LEASE_LOST",
            `Action execution fenced due to lost or expired lease: ${(err as Error).message}`,
            taskId
          );
        }
        throw err;
      }

      // Short-circuit approval pause/rejection before polluting repair state or working context
      const actionErrObj = actionResult.error as { code?: unknown; message?: unknown; details?: Record<string, unknown> } | undefined;
      if (actionResult.status === "FAILED" && actionErrObj?.code === "WAITING_APPROVAL") {
        const det = actionErrObj.details ?? {};
        pendingApprovalIdResult = typeof det.approvalId === "string" ? det.approvalId : undefined;
        pendingApprovalOpResult = typeof det.operation === "string" ? det.operation : action.toolName;
        return assembleResult(
          "WAITING_APPROVAL",
          typeof actionErrObj.message === "string"
            ? actionErrObj.message
            : `Tool '${action.toolName}' is waiting for operator approval`,
          taskId
        );
      }
      if (
        actionResult.status === "FAILED" &&
        (actionErrObj?.code === "APPROVAL_REJECTED" || actionErrObj?.code === "APPROVAL_EXPIRED")
      ) {
        return assembleResult(
          actionErrObj.code,
          typeof actionErrObj.message === "string" ? actionErrObj.message : actionErrObj.code,
          taskId
        );
      }

      if (
        this.scopedMemory &&
        actionResult.status !== "FENCED" &&
        actionResult.status !== "UNKNOWN" &&
        actionResult.status !== "CANCELLED" &&
        hasActiveLeaseAuthority() === null
      ) {
        try {
          const actionMemContent = JSON.stringify(
            redactSensitiveData({
              toolName: action.toolName,
              status: actionResult.status,
              stepNumber: stepCount,
              ...(actionResult.output !== undefined
                ? { outputPreview: String(JSON.stringify(actionResult.output)).slice(0, 512) }
                : {}),
              ...(actionResult.error ? { error: actionResult.error } : {}),
            })
          );
          this.scopedMemory.recordEntry(
            activeTenantId,
            taskId,
            "AGENT_WORKING_CONTEXT",
            `tool.${action.toolName}`,
            actionMemContent,
            {
              runId,
              agentId: workerId,
              isModelGenerated: false,
              isIndependentlyVerified: false,
              idempotencyKey: `m42:action:${runId}:${action.actionId}:${actionResult.status}`,
              nowIso: this.clock.nowIso(),
            }
          );
        } catch {
          // Non-fatal memory log
        }
      }

      // Track bounded repair loop diagnostics and patch stagnation/budget limits
      if (
        action.toolName === "run_command" &&
        actionResult.status === "SUCCEEDED" &&
        typeof (actionResult.output as any)?.exitCode === "number" &&
        (actionResult.output as any).exitCode !== 0 &&
        repairState
      ) {
        hasObservedRepairFailure = true;
        const cmdOut = actionResult.output as Record<string, unknown>;
        const diagCategory = this.boundedRepairLoop.diagnoseFeedback(
          repairState,
          String(cmdOut.stderr ?? ""),
          String(cmdOut.stdout ?? ""),
          Number(cmdOut.exitCode ?? 1)
        );
        this.telemetry?.recordRepairLifecycle({
          outcome: "diagnosed",
          category: diagCategory,
          durationMs: this.clock.now().getTime() - stepStartTime,
        });
        if (this.scopedMemory) {
          try {
            this.scopedMemory.recordEntry(
              activeTenantId,
              taskId,
              "DURABLE_TASK_HISTORY",
              "repair.diagnose",
              JSON.stringify(
                redactSensitiveData({
                  stepNumber: stepCount,
                  category: diagCategory,
                  exitCode: cmdOut.exitCode,
                  summary: repairState.lastDiagnosis?.summary ?? "",
                })
              ),
              {
                runId,
                agentId: workerId,
                isModelGenerated: false,
                isIndependentlyVerified: false,
                idempotencyKey: `m42:diag:${runId}:${action.actionId}`,
                nowIso: this.clock.nowIso(),
              }
            );
          } catch { /* non-fatal */ }
        }
      }

      if (
        (action.toolName === "write_file" || action.toolName === "edit_file") &&
        actionResult.status === "SUCCEEDED" &&
        hasObservedRepairFailure &&
        repairState
      ) {
        const repairEval = this.boundedRepairLoop.evaluateProposedRepair(
          repairState,
          canonicalJsonStringify({ toolName: action.toolName, input: action.inputPayload ?? {} }),
          Math.max(0, this.clock.now().getTime() - stepStartTime)
        );
        if (!repairEval.canProceed) {
          const isStagnant =
            repairEval.haltReason?.toLowerCase().includes("stagnation") ||
            repairEval.haltReason?.toLowerCase().includes("duplicate") ||
            false;
          this.telemetry?.recordRepairLifecycle({
            outcome: isStagnant ? "stagnation_halted" : "budget_exhausted",
            durationMs: this.clock.now().getTime() - stepStartTime,
          });
          this.stateStore.transaction((tx) => {
            tx.appendEvent({
              eventId: crypto.randomUUID(),
              runId,
              timestamp: this.clock.nowIso(),
              eventType: "verification.rejected",
              schemaVersion: 1,
              producer: "application.bounded_repair_loop",
              payload: {
                status: "REPAIR_EXHAUSTED",
                reason: isStagnant ? "REPAIR_STAGNATION" : "REPAIR_BUDGET_EXCEEDED",
                message: repairEval.haltReason ?? "Bounded repair loop halted",
                iterationCount: repairState!.iterationCount,
                cumulativeActions: repairState!.cumulativeActions,
              },
            });
          });
          if (this.scopedMemory) {
            try {
              this.scopedMemory.recordEntry(
                activeTenantId,
                taskId,
                "DURABLE_TASK_HISTORY",
                "repair.controller",
                JSON.stringify(
                  redactSensitiveData({
                    halted: true,
                    reason: repairEval.haltReason,
                    iterationCount: repairState.iterationCount,
                    cumulativeActions: repairState.cumulativeActions,
                  })
                ),
                {
                  runId,
                  agentId: workerId,
                  isModelGenerated: false,
                  isIndependentlyVerified: false,
                  idempotencyKey: `m42:repair_halt:${runId}:${action.actionId}`,
                  nowIso: this.clock.nowIso(),
                }
              );
            } catch { /* non-fatal */ }
          }
          return assembleResult(
            "REPAIR_EXHAUSTED",
            repairEval.haltReason ?? "Bounded repair cycle halted due to budget or stagnation limit",
            taskId
          );
        }
        this.telemetry?.recordRepairLifecycle({
          outcome: "patch_proposed",
          durationMs: this.clock.now().getTime() - stepStartTime,
        });
      }

      let progressAdvisory: string | undefined;
      const inputPayloadRecord = action.inputPayload as Record<string, unknown> | null;
      if (
        actionResult.status === "SUCCEEDED" &&
        validationResult.proposal.toolName === "read_file" &&
        typeof inputPayloadRecord?.path === "string"
      ) {
        try {
          const readPath = inputPayloadRecord.path;
          const outputHash = computeObservationContentHash({
            output: actionResult.output ?? null,
          });
          const isIdenticalCompletedRead =
            lastSuccessfulRead !== undefined &&
            lastSuccessfulRead.path === readPath &&
            lastSuccessfulRead.inputHash === action.inputHash &&
            lastSuccessfulRead.outputHash === outputHash;

          if (isIdenticalCompletedRead && lastSuccessfulRead) {
            lastSuccessfulRead.consecutiveCount++;
            consecutiveIdenticalReads = lastSuccessfulRead.consecutiveCount;

            if (
              lastSuccessfulRead.consecutiveCount >=
                REPEATED_IDENTICAL_READ_ADVISORY_THRESHOLD &&
              !lastSuccessfulRead.advisoryIssued
            ) {
              progressAdvisory =
                `The same read_file request for '${readPath}' returned identical content in consecutive successful actions. ` +
                "The information is already available in context; choose a justified next action or read a meaningfully different range/file.";
              const advisoryContent: Record<string, unknown> = {
                feedbackKind: "REPEATED_IDENTICAL_READ",
                repeatCount: lastSuccessfulRead.consecutiveCount,
                path: readPath,
                inputHash: action.inputHash,
                outputHash,
                message: progressAdvisory,
              };
              const advisoryBytes = estimateBytes(advisoryContent);
              const advisoryObservation: Observation = {
                observationId: `obs-progress-repeated-read-step-${stepCount}`,
                category: "SYSTEM_EVENT",
                provenance: {
                  entityKind: "Action",
                  entityId: action.actionId,
                  runId,
                  sequenceNumber: action.sequenceNumber,
                  timestamp: this.clock.nowIso(),
                  isAuthoritativeRuntimeFact: true,
                },
                freshness: "CURRENT",
                priority: 85,
                content: advisoryContent,
                contentHash: computeObservationContentHash(advisoryContent),
                estimatedBytes: advisoryBytes,
                estimatedTokens: estimateTokens(advisoryBytes),
                isMandatory: true,
              };
              validateObservation(advisoryObservation);
              pendingProgressAdvisoryObservation = advisoryObservation;
              lastSuccessfulRead.advisoryIssued = true;
            }
          } else {
            lastSuccessfulRead = {
              path: readPath,
              inputHash: action.inputHash,
              outputHash,
              consecutiveCount: 1,
              advisoryIssued: false,
            };
            consecutiveIdenticalReads = 1;
          }
        } catch {
          lastSuccessfulRead = undefined;
          consecutiveIdenticalReads = 0;
        }
      } else {
        lastSuccessfulRead = undefined;
        consecutiveIdenticalReads = 0;
      }

      // Track identical successful writes: the same path and requested content, repeated, makes no progress.
      if (
        actionResult.status === "SUCCEEDED" &&
        validationResult.proposal.toolName === "write_file" &&
        typeof inputPayloadRecord?.path === "string"
      ) {
        const writePath = inputPayloadRecord.path;
        if (
          lastSuccessfulWrite !== undefined &&
          lastSuccessfulWrite.path === writePath &&
          lastSuccessfulWrite.inputHash === action.inputHash
        ) {
          lastSuccessfulWrite.consecutiveCount++;
          consecutiveIdenticalWrites = lastSuccessfulWrite.consecutiveCount;

          if (
            lastSuccessfulWrite.consecutiveCount >= REPEATED_IDENTICAL_WRITE_ADVISORY_THRESHOLD &&
            !lastSuccessfulWrite.advisoryIssued
          ) {
            progressAdvisory =
              `The same write_file request for '${writePath}' was already applied successfully with identical content. ` +
              "The file already contains it; finish the task or choose a meaningfully different next action.";
            const advisoryContent: Record<string, unknown> = {
              feedbackKind: "REPEATED_IDENTICAL_WRITE",
              repeatCount: lastSuccessfulWrite.consecutiveCount,
              path: writePath,
              inputHash: action.inputHash,
              message: progressAdvisory,
            };
            const advisoryBytes = estimateBytes(advisoryContent);
            const advisoryObservation: Observation = {
              observationId: `obs-progress-repeated-write-step-${stepCount}`,
              category: "SYSTEM_EVENT",
              provenance: {
                entityKind: "Action",
                entityId: action.actionId,
                runId,
                sequenceNumber: action.sequenceNumber,
                timestamp: this.clock.nowIso(),
                isAuthoritativeRuntimeFact: true,
              },
              freshness: "CURRENT",
              priority: 85,
              content: advisoryContent,
              contentHash: computeObservationContentHash(advisoryContent),
              estimatedBytes: advisoryBytes,
              estimatedTokens: estimateTokens(advisoryBytes),
              isMandatory: true,
            };
            validateObservation(advisoryObservation);
            pendingProgressAdvisoryObservation = advisoryObservation;
            lastSuccessfulWrite.advisoryIssued = true;
          }
        } else {
          lastSuccessfulWrite = {
            path: writePath,
            inputHash: action.inputHash,
            consecutiveCount: 1,
            advisoryIssued: false,
          };
          consecutiveIdenticalWrites = 1;
        }
      } else {
        lastSuccessfulWrite = undefined;
        consecutiveIdenticalWrites = 0;
      }

      // Invalidate duplicate proposal detector on action execution
      this.duplicateProposalDetector.onActionExecuted({
        toolName: action.toolName,
        status: actionResult.status,
        inputPayload: action.inputPayload,
      });

      // Option C: Invalidate failed-anchor tracker on fresh successful read or mutation
      if (action.toolName === "read_file" && actionResult.status === "SUCCEEDED") {
        const readPath =
          typeof (action.inputPayload as any)?.path === "string"
            ? ((action.inputPayload as any).path as string)
            : undefined;
        if (readPath) {
          this.failedAnchorTracker.clearForFile(readPath);
          this.duplicateProposalDetector.clearForTarget(readPath);
        }
      } else if (
        (action.toolName === "write_file" || action.toolName === "edit_file") &&
        actionResult.status === "SUCCEEDED"
      ) {
        const mutatedPath =
          typeof (action.inputPayload as any)?.path === "string"
            ? ((action.inputPayload as any).path as string)
            : undefined;
        if (mutatedPath) {
          this.failedAnchorTracker.clearForFile(mutatedPath);
          this.duplicateProposalDetector.clearForTarget(mutatedPath);
        }
      }

      // Minimal Option D: Search zero-match recovery for failed anchors
      if (action.toolName === "search_code" && actionResult.status === "SUCCEEDED") {
        const searchPayload = action.inputPayload as Record<string, unknown> | null;
        const searchOutput = actionResult.output as Record<string, unknown> | null;
        const query = typeof searchPayload?.query === "string" ? searchPayload.query : undefined;
        const totalMatches =
          typeof searchOutput?.totalMatches === "number"
            ? searchOutput.totalMatches
            : Array.isArray(searchOutput?.matches)
            ? searchOutput.matches.length
            : undefined;

        if (query && totalMatches === 0) {
          const filePattern = typeof searchPayload?.path === "string" ? searchPayload.path : undefined;
          const matchingFailedAnchor = this.failedAnchorTracker.findMatchingFailedAnchor(query, filePattern);
          if (matchingFailedAnchor) {
            const advisoryContent: Record<string, unknown> = {
              advisoryKind: "ZERO_MATCH_FAILED_ANCHOR_SEARCH",
              stepNumber: stepCount,
              query,
              targetPath: matchingFailedAnchor.path,
              guidance:
                `search_code returned 0 matches for '${query}', which also previously failed as an edit_file searchAnchor in '${matchingFailedAnchor.path}'. ` +
                `Stop retrying this anchor. Re-read '${matchingFailedAnchor.path}' using read_file to inspect the actual current file contents and select an exact literal anchor.`,
            };
            const redactedAdvisory = redactSensitiveData(advisoryContent) as Record<string, unknown>;
            const advBytes = estimateBytes(redactedAdvisory);
            const zeroMatchObs: Observation = {
              observationId: `obs-zero-match-failed-anchor-step-${stepCount}`,
              category: "SYSTEM_EVENT",
              provenance: {
                entityKind: "Action",
                entityId: action.actionId,
                runId,
                sequenceNumber: action.sequenceNumber,
                timestamp: this.clock.nowIso(),
                isAuthoritativeRuntimeFact: true,
              },
              freshness: "CURRENT",
              priority: 90,
              content: redactedAdvisory,
              contentHash: computeObservationContentHash(redactedAdvisory),
              estimatedBytes: advBytes,
              estimatedTokens: estimateTokens(advBytes),
              isMandatory: true,
            };
            try {
              validateObservation(zeroMatchObs);
              pendingProgressAdvisoryObservation = zeroMatchObs;
            } catch {
              // Ignore observation validation failures safely
            }
          }
        }
      }

      // Update ContextResidencyTracker
      if (effectiveDynamicToolFiltering) {
        if (
          action.toolName === "read_file" &&
          actionResult.status === "SUCCEEDED" &&
          actionResult.output
        ) {
          try {
            this.contextResidencyTracker.recordRead(
              action.inputPayload as any,
              actionResult.output as any,
              action.sequenceNumber
            );
          } catch {
            // Defense in depth: tracker failure must not crash loop
          }
        } else if (
          (action.toolName === "write_file" || action.toolName === "edit_file") &&
          actionResult.status === "SUCCEEDED"
        ) {
          try {
            this.contextResidencyTracker.recordWorkspaceMutation(
              (action.inputPayload as any)?.path,
              action.sequenceNumber
            );
          } catch {
            // Defense in depth
          }
        } else if (
          actionResult.status === "FAILED" ||
          actionResult.status === "TIMED_OUT" ||
          actionResult.status === "UNKNOWN"
        ) {
          this.contextResidencyTracker.recordExecutionFailure();
        }
      }

      if (
        (action.toolName === "write_file" || action.toolName === "edit_file") &&
        actionResult.status === "SUCCEEDED"
      ) {
        try {
          this.duplicateProposalDetector.recordWorkspaceMutation(
            (action.inputPayload as any)?.path
          );
          this.progressLoopDetector.recordWorkspaceMutation();
        } catch {
          // Defense in depth
        }
      }

      let intermediateVerificationSignature: string | undefined;

      // Intermediate Test-Guided Feedback & Stagnation Tracking for Mutations
      if (
        (action.toolName === "edit_file" || action.toolName === "write_file") &&
        effectiveBudget.enableIntermediateTestFeedback !== false
      ) {
        if (extractReplayBlockDetails(actionResult)) {
          // Replay-blocked: never dispatched, so it is not an ineffective edit (handled in Step G).
        } else if (actionResult.status === "FAILED" || actionResult.status === "TIMED_OUT") {
          consecutiveIneffectiveEdits++;
        } else if (actionResult.status === "SUCCEEDED") {
          const cleanRoomSpecObj = activeContract.spec.verificationSpecs?.find(
            (s) => s.ruleKind === "CLEAN_ROOM_DUAL_GATE"
          );
          const cleanSpec = cleanRoomSpecObj?.expectedValue as CleanRoomVerificationSpec | undefined;

          if (cleanSpec && params.workspace && this.workerRuntime.provider) {
            let testOutput: RunCommandOutput | undefined;
            let isTimedOut = false;
            let testFailed = false;
            let errorMsg = "";
            const testStart = this.clock.now().getTime();

            try {
              const execResult = await this.workerRuntime.provider.execute({
                runId,
                taskId,
                operationName: "run_command",
                inputPayload: {
                  argv: cleanSpec.failToPass.testCommand,
                  cwd: ".",
                  maxOutputBytes: 256 * 1024,
                },
                idempotencyToken: `test-f2p-step-${stepCount}`,
                attemptNumber: 1,
                workspace: params.workspace,
                timeoutMs: Math.min(30000, cleanSpec.timeoutMs ?? 30000),
              });

              if (execResult.status === "TIMED_OUT") {
                isTimedOut = true;
                errorMsg = execResult.error?.message ?? "Test execution timed out";
              } else if (execResult.status === "FAILED") {
                testFailed = true;
                errorMsg = execResult.error?.message ?? "Test process failed to execute";
              } else if (execResult.output) {
                testOutput = execResult.output as RunCommandOutput;
              }
            } catch (err: unknown) {
              testFailed = true;
              errorMsg = err instanceof Error ? err.message : String(err);
            }

            const testDurationMs = this.clock.now().getTime() - testStart;
            const exitCode = isTimedOut ? -1 : (testOutput?.exitCode ?? (testFailed ? 1 : 0));
            const stdout = testOutput?.stdout ?? "";
            const stderr = testOutput?.stderr ?? (errorMsg ? errorMsg : "");

            let classification: "PASS" | "FAIL" | "TIMEOUT" | "REGRESSION" = "FAIL";
            if (isTimedOut) {
              classification = "TIMEOUT";
            } else if (exitCode === cleanSpec.failToPass.expectedPatchedExitCode) {
              let p2pOutput: RunCommandOutput | undefined;
              let p2pTimedOut = false;
              let p2pFailed = false;
              try {
                const p2pExec = await this.workerRuntime.provider.execute({
                  runId,
                  taskId,
                  operationName: "run_command",
                  inputPayload: {
                    argv: cleanSpec.passToPass.testCommand,
                    cwd: ".",
                    maxOutputBytes: 256 * 1024,
                  },
                  idempotencyToken: `test-p2p-step-${stepCount}`,
                  attemptNumber: 1,
                  workspace: params.workspace,
                  timeoutMs: Math.min(30000, cleanSpec.timeoutMs ?? 30000),
                });
                if (p2pExec.status === "TIMED_OUT") p2pTimedOut = true;
                else if (p2pExec.status === "FAILED") p2pFailed = true;
                else if (p2pExec.output) p2pOutput = p2pExec.output as RunCommandOutput;
              } catch {
                p2pFailed = true;
              }

              const p2pExitCode = p2pTimedOut ? -1 : (p2pOutput?.exitCode ?? (p2pFailed ? 1 : 0));
              if (p2pTimedOut || p2pExitCode !== cleanSpec.passToPass.expectedPatchedExitCode) {
                classification = "REGRESSION";
              } else {
                classification = "PASS";
              }
            } else {
              classification = "FAIL";
            }
            intermediateVerificationSignature = `${classification}:${exitCode}`;

            if (classification === "PASS") {
              consecutiveIneffectiveEdits = 0;
              this.progressLoopDetector.recordVerificationState("PASS");
              cycleAdvisoryIssued = false;
              pendingCycleStop = null;
              const targetRelPath =
                typeof (action.inputPayload as any)?.path === "string"
                  ? ((action.inputPayload as any).path as string)
                  : undefined;
              if (targetRelPath) {
                this.duplicateProposalDetector.clearIneffectiveForTarget(targetRelPath);
              }

              if (effectiveBudget.enablePostPassVerificationLatch !== false) {

                if (targetRelPath) {
                  let currentTargetHash: string | undefined;
                  if (params.workspace?.hostPath) {
                    try {
                      const editor = new LineAnchoredEditor();
                      const safePath = editor.resolveSafePath(targetRelPath, params.workspace.hostPath);
                      const raw = fsSync.readFileSync(safePath, "utf-8");
                      currentTargetHash = crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
                    } catch {
                      // Best-effort hash calculation
                    }
                  }

                  this.postPassLatch.activate({
                    stepNumber: stepCount,
                    timestamp: this.clock.nowIso(),
                    protectedPath: targetRelPath,
                    f2pExitCode: exitCode,
                    p2pExitCode: 0,
                    targetHash: currentTargetHash,
                    cleanRoomSpecId: cleanSpec.specId,
                    taskId,
                  });

                  // Persist durable verification.latched event
                  if (hasActiveLeaseAuthority() === null) {
                    try {
                      this.stateStore.transaction((tx) => {
                        tx.appendEvent({
                          eventId: crypto.randomUUID(),
                          runId,
                          timestamp: this.clock.nowIso(),
                          eventType: "verification.latched",
                        schemaVersion: 1,
                        producer: "application.agent_step_controller",
                        payload: {
                          stepNumber: stepCount,
                          protectedPath: targetRelPath,
                          targetHash: currentTargetHash,
                            f2pExitCode: exitCode,
                            p2pExitCode: 0,
                            actionId: action.actionId,
                          },
                        });
                      });
                    } catch {
                      // Safe ignore
                    }
                  }

                  // Authoritative Clean-Room Completion Verification Gate
                  if (this.cleanRoomVerifier && params.workspace) {
                    try {
                      const cleanRoomOutcome = await this.cleanRoomVerifier.verifyCandidatePatch({
                        runId,
                        taskId,
                        workerId,
                        leaseId,
                        contract: activeContract,
                        spec: cleanSpec,
                        agentWorkspace: params.workspace,
                        abortSignal: params.abortSignal,
                      });
                      const crLeaseError = hasActiveLeaseAuthority();
                      if (crLeaseError !== null) {
                        return assembleResult("LEASE_LOST", crLeaseError, taskId);
                      }
                      this.postPassLatch.recordCleanRoomResult(cleanRoomOutcome);

                      if (cleanRoomOutcome.replayBlock) {
                        // Clean-room test command refused by the replay gate: verification did not run.
                        replayBlockCount++;
                        if (replayBlockCount >= 2) {
                          return assembleResult(
                            "POLICY_DENIED",
                            `Repeated clean-room verification blocked by an uncertain prior execution (${replayBlockCount} replay blocks in this run)`,
                            taskId
                          );
                        }
                        pendingActionRecoveryObservation = this.buildReplayBlockFeedback({
                          details: cleanRoomOutcome.replayBlock,
                          runId,
                          entityId:
                            cleanRoomOutcome.replayBlock.priorActionId ?? `clean-room-step-${stepCount}`,
                          stepCount,
                          source: "CLEAN_ROOM_VERIFICATION",
                        });
                      }

                      if (cleanRoomOutcome.status === "VERIFIED") {
                        const verificationEvaluation = this.evaluateCompletionVerification(
                          runId,
                          activeContract,
                          {
                            cleanRoomVerifierAvailable: true,
                            workspaceAvailable: true,
                            cleanRoomOutcome,
                            leaseFencing: { workerId, leaseId },
                          }
                        );
                        if (verificationEvaluation.leaseLost) {
                          return assembleResult(
                            "LEASE_LOST",
                            verificationEvaluation.failureReason ?? `Lease lost during completion verification`,
                            taskId
                          );
                        }
                        if (verificationEvaluation.verified) {
                          transcript.push(
                            Object.freeze({
                              stepNumber: stepCount,
                              contextSnapshotId: contextSnapshot.snapshotId,
                              contextHash: contextSnapshot.contextHash,
                              contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
                              contextBytes: contextSnapshot.totalBytes,
                              contextObservationsCount: contextSnapshot.observations.length,
                              proposalId: validationResult.proposal.proposalId,
                              toolName: validationResult.proposal.toolName,
                              inputHash: action.inputHash,
                              inputPayload: action.inputPayload,
                              rationale: validationResult.proposal.rationale,
                              finishReason: brainResult.finishReason,
                              proposalValid: true,
                              reflexDecision: reflexDecisionResult.decision,
                              reflexReasonCode: reflexDecisionResult.reasonCode,
                              reflexRationale: reflexDecisionResult.rationale,
                              reflexEvidence,
                              reflexDurationMs,
                              actionId: action.actionId,
                              actionStatus: actionResult.status,
                              actionOutput: actionResult.output,
                              actionError: actionResult.error,
                              durationMs: this.clock.now().getTime() - stepStartTime,
                              timestamp: stepTimestamp,
                            })
                          );

                          return assembleResult(
                            "COMPLETED",
                            "Authoritative clean-room verification succeeded after post-pass verification latch activation",
                            taskId
                          );
                        }
                      }
                    } catch {
                      // Clean-room failure or exception does not complete run; loop continues with protected target
                    }
                  }
                }
              }
            } else {
              consecutiveIneffectiveEdits++;
            }

            const boundStdout = stdout.length > 512 ? stdout.slice(0, 500) + " [TRUNCATED]" : stdout;
            const boundStderr = stderr.length > 512 ? stderr.slice(0, 500) + " [TRUNCATED]" : stderr;

            // Option B: Source-grounded verification context snapshot for failed/regressed mutations
            let currentSourceContext: string | undefined;
            let sourceReadError: string | undefined;
            const targetRelPath =
              typeof (action.inputPayload as any)?.path === "string"
                ? ((action.inputPayload as any).path as string)
                : undefined;

            if (classification === "FAIL" || classification === "REGRESSION") {
              if (targetRelPath && params.workspace?.hostPath) {
                try {
                  const editor = new LineAnchoredEditor();
                  const safePath = editor.resolveSafePath(targetRelPath, params.workspace.hostPath);
                  const rawSource = fsSync.readFileSync(safePath, "utf-8");
                  const currentSourceHash = crypto.createHash("sha256").update(rawSource, "utf-8").digest("hex");
                  this.duplicateProposalDetector.recordIneffectiveMutation({
                    toolName: action.toolName,
                    inputPayload: action.inputPayload,
                    targetPath: targetRelPath,
                    stepNumber: stepCount,
                    verificationClassification: classification,
                    sourceHash: currentSourceHash,
                    workspaceMutationVersion: this.duplicateProposalDetector.getWorkspaceMutationVersion(),
                    timestamp: this.clock.nowIso(),
                  });
                  const MAX_SOURCE_BYTES = 2048;
                  const TRUNCATION_SUFFIX = "\n... [TRUNCATED]";
                  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, "utf-8");
                  if (Buffer.byteLength(rawSource, "utf-8") > MAX_SOURCE_BYTES) {
                    const sliceLen = Math.max(0, MAX_SOURCE_BYTES - suffixBytes);
                    const buf = Buffer.from(rawSource, "utf-8").subarray(0, sliceLen);
                    currentSourceContext = buf.toString("utf-8") + TRUNCATION_SUFFIX;
                  } else {
                    currentSourceContext = rawSource;
                  }
                } catch (sourceErr: unknown) {
                  sourceReadError =
                    sourceErr instanceof Error ? sourceErr.message : String(sourceErr);
                }
              }
            }

            const recoveryGuidance =
              classification === "FAIL" || classification === "REGRESSION"
                ? deriveVerificationRecoveryGuidance({
                    classification,
                    exitCode,
                    stderr: boundStderr,
                    stdout: boundStdout,
                    testDurationMs,
                    targetRelPath,
                    currentSourceContext,
                    workspaceHostPath: params.workspace?.hostPath,
                    cleanSpec,
                  })
                : null;

            const testFeedbackContent: Record<string, unknown> = {
              testType: classification === "REGRESSION" ? "PASS_TO_PASS" : "FAIL_TO_PASS",
              testCommand: classification === "REGRESSION" ? cleanSpec.passToPass.testCommand : cleanSpec.failToPass.testCommand,
              exitCode,
              classification,
              isTimedOut,
              durationMs: testDurationMs,
              ...(boundStdout ? { stdout: boundStdout } : {}),
              ...(boundStderr ? { stderr: boundStderr } : {}),
              ...(currentSourceContext !== undefined ? { currentSourceContext } : {}),
              ...(sourceReadError !== undefined ? { sourceReadError } : {}),
              ...(recoveryGuidance?.verificationAnalysis !== undefined
                ? { verificationAnalysis: recoveryGuidance.verificationAnalysis }
                : {}),
              ...(recoveryGuidance?.recoveryAdvisory !== undefined
                ? { recoveryAdvisory: recoveryGuidance.recoveryAdvisory }
                : {}),
              summary: classification === "PASS"
                ? `Verification tests PASSED (exit code ${exitCode}). The defect appears repaired.`
                : classification === "REGRESSION"
                ? `Regression detected: failToPass passed but regression test (passToPass) FAILED with exit code ${exitCode}.${recoveryGuidance?.recoveryAdvisory ? ` Recovery advisory: ${recoveryGuidance.recoveryAdvisory}` : ""}`
                : classification === "TIMEOUT"
                ? `Verification test TIMED OUT after ${testDurationMs}ms.`
                : `Verification test FAILED with exit code ${exitCode} (expected ${cleanSpec.failToPass.expectedPatchedExitCode}). ${boundStderr ? `Error: ${boundStderr}` : ""}${recoveryGuidance?.recoveryAdvisory ? ` Recovery advisory: ${recoveryGuidance.recoveryAdvisory}` : ""}`,
            };

            const redactedContent = redactSensitiveData(testFeedbackContent) as Record<string, unknown>;
            const estBytes = estimateBytes(redactedContent);

            const testObs: Observation = {
              observationId: `obs-test-feedback-step-${stepCount}`,
              category: "VERIFICATION",
              provenance: {
                entityKind: "VerificationSpec",
                entityId: cleanSpec.specId,
                runId,
                sequenceNumber: stepCount,
                timestamp: this.clock.now().toISOString(),
                isAuthoritativeRuntimeFact: true,
              },
              freshness: "CURRENT",
              priority: 95,
              content: redactedContent,
              contentHash: computeObservationContentHash(redactedContent),
              estimatedBytes: estBytes,
              estimatedTokens: estimateTokens(estBytes),
              isMandatory: true,
            };
            try {
              validateObservation(testObs);
              pendingTestFeedbackObservation = testObs;
            } catch {
              pendingTestFeedbackObservation = null;
            }
          }
        }
      }

      // Record Completed Step Transcript
      transcript.push(
        Object.freeze({
          stepNumber: stepCount,
          contextSnapshotId: contextSnapshot.snapshotId,
          contextHash: contextSnapshot.contextHash,
          contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
          contextBytes: contextSnapshot.totalBytes,
          contextObservationsCount: contextSnapshot.observations.length,
          proposalId: validationResult.proposal.proposalId,
          toolName: validationResult.proposal.toolName,
          inputHash: action.inputHash,
          inputPayload: action.inputPayload,
          rationale: validationResult.proposal.rationale,
          finishReason: brainResult.finishReason,
          proposalValid: true,
          reflexDecision: reflexDecisionResult.decision,
          reflexReasonCode: reflexDecisionResult.reasonCode,
          reflexRationale: reflexDecisionResult.rationale,
          reflexEvidence,
          reflexDurationMs,
          actionId: action.actionId,
          actionStatus: actionResult.status,
          actionOutput: actionResult.output,
          actionError: actionResult.error,
          ...(progressAdvisory ? { progressAdvisory } : {}),
          ...(effectiveDynamicToolFiltering
            ? {
                eligibleTools: availableTools.map((t) => t.name),
                filteredTools: filteredToolNames,
              }
            : {}),
          durationMs: this.clock.now().getTime() - stepStartTime,
          timestamp: stepTimestamp,
        })
      );


      // Step G: Process Action Execution Outcome
      if (actionResult.status === "UNKNOWN") {
        // Critical UNKNOWN safety stop: outcome is physically uncertain
        return assembleResult(
          "UNKNOWN_EXECUTION",
          `Action '${action.actionId}' produced UNKNOWN execution outcome: physical side effects are uncertain`,
          taskId
        );
      }

      if (actionResult.status === "FENCED") {
        return assembleResult(
          "LEASE_LOST",
          `Action '${action.actionId}' execution fenced due to lost lease`,
          taskId
        );
      }

      if (actionResult.status === "CANCELLED") {
        return assembleResult(
          "CANCELLED",
          `Action '${action.actionId}' was cancelled during execution`,
          taskId
        );
      }

      // Tier-1 replay gate outcome (Milestone 2.10G). The block is a runtime policy result, not an
      // ordinary tool failure: explain it once, and stop if the model repeats a blocked proposal.
      // Only actual WorkerRuntime replay-block results are counted, never similar-looking payloads.
      const replayBlockDetails = extractReplayBlockDetails(actionResult);
      if (replayBlockDetails) {
        replayBlockCount++;
        if (replayBlockCount >= 2) {
          return assembleResult(
            "POLICY_DENIED",
            `Repeated proposal blocked by an uncertain prior execution: Action '${action.actionId}' was ` +
              `refused again (${replayBlockCount} replay blocks in this run)`,
            taskId
          );
        }

        pendingActionRecoveryObservation = this.buildReplayBlockFeedback({
          details: replayBlockDetails,
          runId,
          entityId: action.actionId,
          stepCount,
          source: "ACTION_LOOP",
        });
        continue;
      }

      if (actionResult.status === "FAILED" || actionResult.status === "TIMED_OUT") {
        consecutiveFailures++;
        if (repairState) {
          hasObservedRepairFailure = true;
          const failMsg =
            actionResult.error instanceof Error
              ? actionResult.error.message
              : typeof (actionResult.error as any)?.message === "string"
                ? (actionResult.error as any).message
                : String(actionResult.error ?? actionResult.status);
          const diagCat = this.boundedRepairLoop.diagnoseFeedback(
            repairState,
            failMsg,
            "",
            actionResult.status === "TIMED_OUT" ? -1 : 1
          );
          this.telemetry?.recordRepairLifecycle({ outcome: "diagnosed", category: diagCat });
          if (this.scopedMemory) {
            try {
              this.scopedMemory.recordEntry(
                activeTenantId,
                taskId,
                "DURABLE_TASK_HISTORY",
                "repair.action_failure",
                JSON.stringify(
                  redactSensitiveData({
                    stepNumber: stepCount,
                    toolName: action.toolName,
                    category: diagCat,
                    message: failMsg.slice(0, 500),
                  })
                ),
                {
                  runId,
                  agentId: workerId,
                  isModelGenerated: false,
                  isIndependentlyVerified: false,
                  idempotencyKey: `m42:fail:${runId}:${action.actionId}`,
                  nowIso: this.clock.nowIso(),
                }
              );
            } catch { /* non-fatal */ }
          }
        }

        // Phase 48A & 48D: Add bounded recovery feedback and track failed edit_file search anchors
        if (action.toolName === "edit_file" && actionResult.status === "FAILED") {
          const rawError =
            actionResult.error instanceof Error
              ? actionResult.error.message
              : typeof (actionResult.error as any)?.message === "string"
              ? (actionResult.error as any).message
              : String(actionResult.error ?? "");

          const errorSubcode = (actionResult.error as any)?.subcode;
          const isStalePrecondition =
            errorSubcode === "STALE_PRECONDITION" ||
            rawError.includes("Stale edit precondition failed");

          const isMissing =
            !isStalePrecondition &&
            (rawError.includes("Search anchor not found") ||
              rawError.includes("0 occurrences matched"));
          const isAmbiguous =
            !isStalePrecondition &&
            (rawError.includes("Ambiguous anchor") ||
              rawError.includes("occurred multiple times"));

          if (isStalePrecondition || isMissing || isAmbiguous) {
            const editPayload = action.inputPayload as Record<string, unknown> | null;
            const targetPath = typeof editPayload?.path === "string" ? editPayload.path : "target file";
            const searchAnchor = typeof editPayload?.searchAnchor === "string" ? editPayload.searchAnchor : undefined;

            // Option C: Record failed anchor in tracker (only for missing or ambiguous anchors)
            if ((isMissing || isAmbiguous) && targetPath && searchAnchor) {
              this.failedAnchorTracker.recordFailure(
                targetPath,
                searchAnchor,
                isMissing ? "MISSING" : "AMBIGUOUS",
                stepCount
              );
            }

            const recoveryGuidance = isStalePrecondition
              ? `Edit precondition failed for '${targetPath}': the target file state did not match the expected precondition. ` +
                `To recover: 1) Re-read the current target file using 'read_file'. ` +
                `2) Re-ground your literal searchAnchor and replacementText in the actual current source code. ` +
                `3) Propose a localized edit without supplying any invented or external digest. ` +
                `4) Do not copy hash strings from mission context or other observations.`
              : isMissing
              ? `Search anchor not found in '${targetPath}'. To recover: ` +
                `1) Re-read the file or inspect the most recent actual source output. ` +
                `2) Copy an exact literal text fragment from that source. Do not invent function declarations, helper names, or code structures not present in the target file. ` +
                `3) Choose a smaller, unique anchor around the intended change. ` +
                `4) Avoid pseudo-selectors such as line:10. ` +
                `5) Use edit_file with the verified literal anchor rather than retrying a prohibited whole-file overwrite.`
              : `Search anchor occurred multiple times in '${targetPath}'. To recover: ` +
                `1) Include more surrounding context lines in the searchAnchor to make it unique. ` +
                `2) Re-read the file using read_file to inspect the actual source. ` +
                `3) Propose edit_file with the expanded unique anchor.`;

            const recoveryContent: Record<string, unknown> = {
              feedbackKind: "ACTION_RECOVERY_GUIDANCE",
              stepNumber: stepCount,
              toolName: "edit_file",
              targetPath,
              failureReason: isStalePrecondition
                ? "STALE_EDIT_PRECONDITION"
                : isMissing
                ? "SEARCH_ANCHOR_NOT_FOUND"
                : "AMBIGUOUS_ANCHOR",
              guidance: recoveryGuidance,
              rawError: isStalePrecondition
                ? "Stale edit precondition failed: file content hash did not match expected precondition."
                : sanitizeRejectionMessage(rawError),
            };

            const redactedContent = redactSensitiveData(recoveryContent) as Record<string, unknown>;
            const estBytes = estimateBytes(redactedContent);

            const recoveryObs: Observation = {
              observationId: `obs-edit-recovery-step-${stepCount}`,
              category: "TOOL_ERROR",
              provenance: {
                entityKind: "Action",
                entityId: action.actionId,
                runId,
                sequenceNumber: stepCount,
                timestamp: this.clock.now().toISOString(),
                isAuthoritativeRuntimeFact: true,
              },
              freshness: "CURRENT",
              priority: 90,
              content: redactedContent,
              contentHash: computeObservationContentHash(redactedContent),
              estimatedBytes: estBytes,
              estimatedTokens: estimateTokens(estBytes),
              isMandatory: true,
            };

            try {
              validateObservation(recoveryObs);
              pendingActionRecoveryObservation = recoveryObs;
            } catch {
              pendingActionRecoveryObservation = null;
            }
          }
        }
      } else if (actionResult.status === "SUCCEEDED") {
        consecutiveFailures = 0;
      }

      // Progress Accounting & Multi-Step Loop Detection (Milestone 2.24)
      if (effectiveBudget.enableProgressLoopDetection !== false) {
        const progressAssessment = this.progressLoopDetector.recordStep({
          stepNumber: stepCount,
          actionId: action.actionId,
          sequenceNumber: action.sequenceNumber,
          toolName: action.toolName,
          inputPayload: action.inputPayload,
          inputHash: action.inputHash,
          status: actionResult.status,
          output: actionResult.output,
          verificationSignature: intermediateVerificationSignature,
        });

        if (progressAssessment.classification === "REPEATED_CYCLE") {
          pendingCycleStop = progressAssessment;
        } else if (
          progressAssessment.classification === "NO_PROGRESS" &&
          progressAssessment.repetitionCount &&
          progressAssessment.repetitionCount >= 1 &&
          progressAssessment.cycleLength &&
          progressAssessment.cyclePattern &&
          !cycleAdvisoryIssued
        ) {
          const advPattern = progressAssessment.cyclePattern.join(" -> ");
          const cycleAdvisoryMsg =
            `A repeating multi-step action cycle [${advPattern}] was detected without observable progress. ` +
            "Continuing to repeat this sequence without state or verification progress will result in cycle stagnation termination. " +
            "Please select a meaningfully different action or approach.";
          const advisoryContent: Record<string, unknown> = {
            feedbackKind: "REPEATED_ACTION_CYCLE",
            repeatCount: progressAssessment.repetitionCount,
            cycleLength: progressAssessment.cycleLength,
            pattern: progressAssessment.cyclePattern,
            message: cycleAdvisoryMsg,
          };
          const advisoryBytes = estimateBytes(advisoryContent);
          const advisoryObservation: Observation = {
            observationId: `obs-progress-cycle-step-${stepCount}`,
            category: "SYSTEM_EVENT",
            provenance: {
              entityKind: "Action",
              entityId: action.actionId,
              runId,
              sequenceNumber: action.sequenceNumber,
              timestamp: this.clock.nowIso(),
              isAuthoritativeRuntimeFact: true,
            },
            freshness: "CURRENT",
            priority: 85,
            content: advisoryContent,
            contentHash: computeObservationContentHash(advisoryContent),
            estimatedBytes: advisoryBytes,
            estimatedTokens: estimateTokens(advisoryBytes),
            isMandatory: true,
          };
          try {
            validateObservation(advisoryObservation);
            pendingProgressAdvisoryObservation = advisoryObservation;
            cycleAdvisoryIssued = true;
          } catch {
            // Best-effort observation validation
          }
        }
      }

      // Safe step boundary: persist durable checkpoint after step execution and all updates
      persistLoopCheckpoint(action.actionId, (actionResult as any)?.attemptNumber ?? null);
    }
  }

  /**
   * Builds the mandatory, payload-free TOOL_ERROR observation explaining a Tier-1 replay block.
   * Single source for the action loop, the verification stage and clean-room verification.
   * Returns null if the observation fails validation (feedback is then simply not queued).
   */
  private buildReplayBlockFeedback(params: {
    readonly details: Record<string, string>;
    readonly runId: string;
    readonly entityId: string;
    readonly stepCount: number;
    readonly source: "ACTION_LOOP" | "VERIFICATION_STAGE" | "CLEAN_ROOM_VERIFICATION";
  }): Observation | null {
    const content = redactSensitiveData({
      feedbackKind: "REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT",
      stepNumber: params.stepCount,
      blockCode: REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT,
      source: params.source,
      ...params.details,
      guidance:
        "This proposal was NOT dispatched: an identical earlier action has an unresolved physical outcome. " +
        "Do not repeat the identical proposal; it will not be dispatched. " +
        "Choose a materially different safe action, or finish the task.",
    }) as Record<string, unknown>;
    const bytes = estimateBytes(content);
    const observation: Observation = {
      observationId: `obs-replay-block-step-${params.stepCount}`,
      category: "TOOL_ERROR",
      provenance: {
        entityKind: "Action",
        entityId: params.entityId,
        runId: params.runId,
        sequenceNumber: params.stepCount,
        timestamp: this.clock.now().toISOString(),
        isAuthoritativeRuntimeFact: true,
      },
      freshness: "CURRENT",
      priority: 90,
      content,
      contentHash: computeObservationContentHash(content),
      estimatedBytes: bytes,
      estimatedTokens: estimateTokens(bytes),
      isMandatory: true,
    };
    try {
      validateObservation(observation);
      return observation;
    } catch {
      return null;
    }
  }

  /**
   * Phase 13D: Governed Verification Stage Execution.
   *
   * Executes contract-declared physical verification actions (e.g. git_diff, run_command)
   * through the authoritative WorkerRuntime -> ToolExecutionGateway -> ExecutionProvider pipeline.
   *
   * Invariants:
   * 1. Governed Execution: Dispatched exclusively through WorkerRuntime.executeAction (zero direct exec/spawn).
   * 2. Full Visibility: Actions, Attempts, events, and observations are durably recorded in SQLite.
   * 3. Loop Prevention: Prohibits repetitive verification loops when verification already ran on the current mutation state and failed.
   * 4. Bounded: Obeys action budget, wall clock budget, and cancellation signals.
   */
  private async executeGovernedVerificationStage(params: {
    readonly runId: string;
    readonly taskId: string;
    readonly contract: MissionContract;
    readonly workerId: string;
    readonly leaseId: string;
    readonly workspace?: {
      readonly workspaceId: string;
      readonly hostPath: string;
      readonly containerMountPath?: string;
    };
    readonly abortSignal?: AbortSignal;
    readonly effectiveBudget: StepControllerBudget;
    readonly currentAgentActionCount: number;
    readonly currentVerificationActionCount: number;
    readonly consecutiveFailures: number;
    readonly replayBlockCount: number;
    readonly stepCount: number;
    readonly startTime: number;
    readonly stepStartTime: number;
    readonly stepTimestamp: string;
    readonly contextSnapshot: ContextSnapshot;
    readonly transcript: StepTranscriptEntry[];
    readonly assembleResult: (
      reason: StepControllerTerminalReason,
      message: string
    ) => StepControllerResult;
  }): Promise<{
    readonly updatedAgentActionCount: number;
    readonly updatedVerificationActionCount: number;
    readonly updatedConsecutiveFailures: number;
    readonly updatedReplayBlockCount: number;
    readonly replayFeedback?: Observation | null;
    readonly terminalResult?: StepControllerResult;
    /** Last verification action executed by this stage invocation (for checkpointing), if any. */
    readonly lastVerificationActionId?: string;
    readonly lastVerificationAttemptNumber?: number | null;
  }> {
    let agentActionCount = params.currentAgentActionCount;
    let verificationActionCount = params.currentVerificationActionCount;
    let lastVerificationActionId: string | undefined;
    let lastVerificationAttemptNumber: number | null = null;
    let consecutiveFailures = params.consecutiveFailures;
    let replayBlockCount = params.replayBlockCount;
    let replayFeedback: Observation | null | undefined;
    const vSpecs = params.contract.spec.verificationSpecs ?? [];
    if (vSpecs.length === 0 || !params.workspace) {
      return {
        updatedAgentActionCount: agentActionCount,
        updatedVerificationActionCount: verificationActionCount,
        updatedConsecutiveFailures: consecutiveFailures,
        updatedReplayBlockCount: replayBlockCount,
      };
    }

    const actions = this.stateStore.getActionsForRun(params.runId);

    // A command declared by an EXIT_CODE_ZERO verification spec is a check, not a workspace mutation:
    // counting it as one would invalidate earlier verification passes and re-execute them.
    const isVerificationSpecCommand = (act: { toolName: string; inputPayload: unknown }): boolean =>
      vSpecs.some((s) => {
        if (s.ruleKind !== "EXIT_CODE_ZERO") return false;
        const expected = s.expectedValue as Record<string, unknown> | undefined;
        const specTool = (expected?.toolName as string) ?? "run_command";
        const specArgv = Array.isArray(expected?.argv) ? (expected!.argv as readonly unknown[]) : undefined;
        if (act.toolName !== specTool || !specArgv) return false;
        const inputArgv = (act.inputPayload as any)?.argv;
        return (
          Array.isArray(inputArgv) &&
          inputArgv.length === specArgv.length &&
          inputArgv.every((v: unknown, idx: number) => v === specArgv[idx])
        );
      });

    // 1. Check prerequisite mutation requirement
    const requiresMutation = vSpecs.some(
      (s) => (s.expectedValue as Record<string, unknown> | undefined)?.requireMutation
    );

    let lastWriteActionIndex = -1;
    for (let i = actions.length - 1; i >= 0; i--) {
      const act = actions[i]!;
      // Mutation can be performed by write_file, edit_file, or mutating run_command
      if (act.toolName === "write_file" || act.toolName === "edit_file" || act.toolName === "run_command") {
        if (isVerificationSpecCommand(act)) continue;
        const attempts = this.stateStore.getAttemptsForAction(act.actionId);
        if (attempts.some((att) => att.status === "SUCCEEDED")) {
          lastWriteActionIndex = i;
          break;
        }
      }
    }

    // If mutation is required but no successful write/command action exists, do not execute verification stage
    if (requiresMutation && lastWriteActionIndex === -1) {
      return {
        updatedAgentActionCount: agentActionCount,
        updatedVerificationActionCount: verificationActionCount,
        updatedConsecutiveFailures: consecutiveFailures,
        updatedReplayBlockCount: replayBlockCount,
      };
    }

    const actionsAfterLastWrite = lastWriteActionIndex >= 0 ? actions.slice(lastWriteActionIndex + 1) : actions;

    // 2. Determine verification actions to execute
    interface VerificationActionTask {
      readonly toolName: ToolName;
      readonly inputPayload: unknown;
      readonly specId?: string;
      readonly targetArgv?: readonly string[];
    }

    const tasksToExecute: VerificationActionTask[] = [];

    const maxVerificationActions =
      params.effectiveBudget.maxVerificationActions ?? DEFAULT_MAX_VERIFICATION_ACTIONS;
    const maxVerificationWallClockMs =
      params.effectiveBudget.maxVerificationWallClockMs ?? DEFAULT_MAX_VERIFICATION_WALL_CLOCK_MS;
    // Deterministic per-command ceiling (stable input hash across replay): never above the verification budget.
    const verificationCommandTimeoutMs = Math.max(
      1,
      Math.min(60000, params.contract.spec.resourceLimits.timeoutMs, maxVerificationWallClockMs)
    );

    // 2a. Diff requirement
    const requiresDiff = vSpecs.some(
      (s) => (s.expectedValue as Record<string, unknown> | undefined)?.requireDiff
    );
    if (requiresDiff) {
      const hasDiffAfterMutation = actionsAfterLastWrite.some((a) => {
        if (a.toolName !== "git_diff") return false;
        const attempts = this.stateStore.getAttemptsForAction(a.actionId);
        return attempts.some((att) => att.status === "SUCCEEDED");
      });
      if (!hasDiffAfterMutation) {
        tasksToExecute.push({
          toolName: "git_diff",
          inputPayload: { path: "." },
          specId: "diff-requirement",
        });
      }
    }

    // 2b. Test command requirements (EXIT_CODE_ZERO)
    for (const spec of vSpecs) {
      if (spec.ruleKind === "EXIT_CODE_ZERO") {
        const expected = spec.expectedValue as Record<string, unknown> | undefined;
        const targetTool = ((expected?.toolName as string) ?? "run_command") as ToolName;
        const targetArgv = Array.isArray(expected?.argv)
          ? (expected!.argv as readonly string[])
          : undefined;

        // Check if verification for this spec has already executed and passed on current state
        const hasPassedOnCurrentState = actionsAfterLastWrite.some((a) => {
          if (a.toolName !== targetTool) return false;
          if (targetArgv) {
            const inputArgv = (a.inputPayload as any)?.argv;
            if (!Array.isArray(inputArgv)) return false;
            if (inputArgv.length !== targetArgv.length) return false;
            if (!inputArgv.every((v, idx) => v === targetArgv[idx])) return false;
          }
          const attempts = this.stateStore.getAttemptsForAction(a.actionId);
          const latestAttempt = attempts[attempts.length - 1];
          if (!latestAttempt) return false;
          const exitCode =
            latestAttempt.exitCode !== null && latestAttempt.exitCode !== undefined
              ? latestAttempt.exitCode
              : (latestAttempt.outputPayload as any)?.exitCode !== undefined
              ? (latestAttempt.outputPayload as any).exitCode
              : null;
          return exitCode === 0;
        });

        if (hasPassedOnCurrentState) {
          continue; // Already verified and passed
        }

        // Loop Prevention (Section 16 / Step 10 audit):
        // Only prevent execution if THIS SPECIFIC verification command itself already ran and failed
        // as the most recent action on the unchanged workspace state without intervening agent actions.
        if (actions.length > 0) {
          const lastAction = actions[actions.length - 1]!;
          if (lastAction.toolName === targetTool) {
            let matchesArgv = true;
            if (targetArgv) {
              const inputArgv = (lastAction.inputPayload as any)?.argv;
              matchesArgv =
                Array.isArray(inputArgv) &&
                inputArgv.length === targetArgv.length &&
                inputArgv.every((v, idx) => v === targetArgv[idx]);
            }
            if (matchesArgv) {
              const attempts = this.stateStore.getAttemptsForAction(lastAction.actionId);
              const latestAttempt = attempts[attempts.length - 1];
              const exitCode =
                latestAttempt?.exitCode !== null && latestAttempt?.exitCode !== undefined
                  ? latestAttempt.exitCode
                  : (latestAttempt?.outputPayload as any)?.exitCode !== undefined
                  ? (latestAttempt?.outputPayload as any).exitCode
                  : null;
              if (latestAttempt?.status === "FAILED" || (exitCode !== null && exitCode !== 0)) {
                // The exact verification command failed on the latest action, and no intervening
                // agent actions have been performed. Do not loop.
                continue;
              }
            }
          }
        }

        tasksToExecute.push({
          toolName: targetTool,
          inputPayload: {
            ...(targetArgv ? { argv: targetArgv } : {}),
            timeoutMs: verificationCommandTimeoutMs,
          },
          specId: spec.specId,
          targetArgv,
        });
      }
    }

    const stageStartTime = this.clock.now().getTime();

    // 4. Sequentially execute required verification actions through WorkerRuntime
    for (const task of tasksToExecute) {
      // Check cancellation
      if (params.abortSignal?.aborted) {
        return {
          updatedAgentActionCount: agentActionCount,
          updatedVerificationActionCount: verificationActionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "CANCELLED",
            `Autonomous loop aborted by AbortSignal prior to verification action '${task.toolName}'`
          ),
        };
      }

      // Check run-level wall-clock budget
      const totalElapsedMs = this.clock.now().getTime() - params.startTime;
      if (totalElapsedMs >= params.effectiveBudget.maxWallClockMs) {
        return {
          updatedAgentActionCount: agentActionCount,
          updatedVerificationActionCount: verificationActionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "MAX_WALL_CLOCK",
            `Run wall clock ceiling reached prior to verification action '${task.toolName}' (${totalElapsedMs}ms >= ${params.effectiveBudget.maxWallClockMs}ms)`
          ),
        };
      }

      // Check verification-specific wall-clock budget (Milestone 2.28 Phase 5 Step 12)
      const stageElapsedMs = this.clock.now().getTime() - stageStartTime;
      if (stageElapsedMs >= maxVerificationWallClockMs) {
        return {
          updatedAgentActionCount: agentActionCount,
          updatedVerificationActionCount: verificationActionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "MAX_WALL_CLOCK",
            `Verification wall clock ceiling reached prior to verification action '${task.toolName}' (${stageElapsedMs}ms >= ${maxVerificationWallClockMs}ms)`
          ),
        };
      }

      // Check verification action ceiling (Milestone 2.28 Phase 5 Step 12: separate verification action budget)
      if (verificationActionCount >= maxVerificationActions) {
        return {
          updatedAgentActionCount: agentActionCount,
          updatedVerificationActionCount: verificationActionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "MAX_ACTIONS",
            `Maximum verification action execution ceiling reached prior to verification action '${task.toolName}' (${verificationActionCount} >= ${maxVerificationActions})`
          ),
        };
      }

      // Check lease ownership & expiration
      const preExecRun = this.stateStore.getRun(params.runId);
      if (!preExecRun || preExecRun.leaseId !== params.leaseId || preExecRun.currentWorkerId !== params.workerId) {
        return {
          updatedAgentActionCount: agentActionCount,
          updatedVerificationActionCount: verificationActionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "LEASE_LOST",
            `Lease lost prior to executing verification action '${task.toolName}'`
          ),
        };
      }
      if (preExecRun.leaseExpiresAt && this.clock.nowIso() >= preExecRun.leaseExpiresAt) {
        return {
          updatedAgentActionCount: agentActionCount,
          updatedVerificationActionCount: verificationActionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "LEASE_LOST",
            `Lease expired prior to executing verification action '${task.toolName}' (expired at '${preExecRun.leaseExpiresAt}')`
          ),
        };
      }

      // Execute via governed WorkerRuntime pipeline
      verificationActionCount++;
      const actionStart = this.clock.now().getTime();
      const actionTimestamp = this.clock.nowIso();

      // Determine the maximum command timeout constrained by remaining verification and run wall-clock budgets
      const stageElapsedForTimeout = this.clock.now().getTime() - stageStartTime;
      const remainingVerificationBudgetMs = Math.max(1, maxVerificationWallClockMs - stageElapsedForTimeout);
      const totalElapsedForTimeout = this.clock.now().getTime() - params.startTime;
      const remainingRunBudgetMs = Math.max(1, params.effectiveBudget.maxWallClockMs - totalElapsedForTimeout);
      const effectiveCommandTimeoutMs = Math.max(
        1,
        Math.min(
          verificationCommandTimeoutMs,
          remainingVerificationBudgetMs,
          remainingRunBudgetMs
        )
      );

      const effectiveInputPayload =
        task.inputPayload && typeof task.inputPayload === "object"
          ? {
              ...(task.inputPayload as Record<string, unknown>),
              timeoutMs: effectiveCommandTimeoutMs,
            }
          : task.inputPayload;

      let actionResult: WorkerActionResult;
      try {
        actionResult = await this.workerRuntime.executeAction({
          runId: params.runId,
          toolName: task.toolName,
          inputPayload: effectiveInputPayload,
          leaseId: params.leaseId,
          workspace: params.workspace,
          timeoutMs: effectiveCommandTimeoutMs,
          maxOutputBytes: params.contract.spec.resourceLimits.maxOutputBytes,
          abortSignal: params.abortSignal,
          systemVerificationSpecId: task.specId,
        });
      } catch (err: unknown) {
        if (err instanceof LeaseLostError || err instanceof LeaseExpiredError) {
          return {
            updatedAgentActionCount: agentActionCount,
            updatedVerificationActionCount: verificationActionCount,
            updatedConsecutiveFailures: consecutiveFailures,
            updatedReplayBlockCount: replayBlockCount,
            terminalResult: params.assembleResult("LEASE_LOST", err.message),
          };
        }
        consecutiveFailures++;
        return {
          updatedAgentActionCount: agentActionCount,
          updatedVerificationActionCount: verificationActionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "BRAIN_FAILURE",
            `Physical execution provider error during verification action '${task.toolName}': ${err instanceof Error ? err.message : String(err)}`
          ),
        };
      }

      if (actionResult.actionId) {
        lastVerificationActionId = actionResult.actionId;
        lastVerificationAttemptNumber = (actionResult as any)?.attemptNumber ?? null;
      }

      params.transcript.push(
        Object.freeze({
          stepNumber: params.stepCount,
          contextSnapshotId: params.contextSnapshot.snapshotId,
          contextHash: params.contextSnapshot.contextHash,
          contextEstimatedTokens: params.contextSnapshot.totalEstimatedTokens,
          contextBytes: params.contextSnapshot.totalBytes,
          contextObservationsCount: params.contextSnapshot.observations.length,
          toolName: task.toolName,
          inputPayload: effectiveInputPayload,
          rationale: "SYSTEM_INDEPENDENT_VERIFICATION",
          provenance: "SYSTEM_VERIFICATION",
          finishReason: "GOAL_REACHED",
          proposalValid: true,
          actionId: actionResult.actionId,
          actionStatus: actionResult.status,
          actionOutput: actionResult.output,
          actionError: actionResult.error,
          durationMs: this.clock.now().getTime() - actionStart,
          timestamp: actionTimestamp,
        })
      );

      // Outcome checks
      if (actionResult.status === "UNKNOWN") {
        return {
          updatedAgentActionCount: agentActionCount,
          updatedVerificationActionCount: verificationActionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "UNKNOWN_EXECUTION",
            `Verification action '${actionResult.actionId}' produced UNKNOWN execution outcome: physical side effects are uncertain`
          ),
        };
      }

      if (actionResult.status === "FENCED") {
        return {
          updatedAgentActionCount: agentActionCount,
          updatedVerificationActionCount: verificationActionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "LEASE_LOST",
            `Verification action '${actionResult.actionId}' execution fenced due to lost lease`
          ),
        };
      }

      if (actionResult.status === "CANCELLED") {
        return {
          updatedAgentActionCount: agentActionCount,
          updatedVerificationActionCount: verificationActionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "CANCELLED",
            `Verification action '${actionResult.actionId}' was cancelled during execution`
          ),
        };
      }

      // Tier-1 replay block: not dispatched; the earlier execution's outcome stays unresolved. It is
      // neither a verification failure nor evidence that the earlier execution did or did not occur.
      const replayBlockDetails = extractReplayBlockDetails(actionResult);
      if (replayBlockDetails) {
        replayBlockCount++;
        if (replayBlockCount >= 2) {
          return {
            updatedAgentActionCount: agentActionCount,
            updatedVerificationActionCount: verificationActionCount,
            updatedConsecutiveFailures: consecutiveFailures,
            updatedReplayBlockCount: replayBlockCount,
            terminalResult: params.assembleResult(
              "POLICY_DENIED",
              `Repeated verification proposal blocked by an uncertain prior execution: Action '${actionResult.actionId}' was refused again (${replayBlockCount} replay blocks in this run)`
            ),
          };
        }
        replayFeedback = this.buildReplayBlockFeedback({
          details: replayBlockDetails,
          runId: params.runId,
          entityId: actionResult.actionId,
          stepCount: params.stepCount,
          source: "VERIFICATION_STAGE",
        });
        break; // Never continue to further verification tasks, never redispatch the blocked one
      }

      if (actionResult.status === "FAILED" || actionResult.status === "TIMED_OUT") {
        consecutiveFailures++;
        break; // Stop further verification tasks on physical failure
      }

      // Check if command succeeded at runtime level but test exited non-zero
      if (task.toolName === "run_command") {
        const exitCode =
          (actionResult.output as any)?.exitCode !== undefined
            ? (actionResult.output as any).exitCode
            : null;
        if (exitCode !== 0) {
          consecutiveFailures++;
          break; // Test failed, stop executing further verification tasks
        } else {
          consecutiveFailures = 0;
        }
      } else {
        consecutiveFailures = 0;
      }
    }

    return {
      updatedAgentActionCount: agentActionCount,
      updatedVerificationActionCount: verificationActionCount,
      updatedConsecutiveFailures: consecutiveFailures,
      updatedReplayBlockCount: replayBlockCount,
      ...(replayFeedback !== undefined ? { replayFeedback } : {}),
      ...(lastVerificationActionId
        ? { lastVerificationActionId, lastVerificationAttemptNumber }
        : {}),
    };
  }

  /**
   * Authoritative Completion Verification Gate (Phase 13B).
   *
   * Enforces the unskippable invariant:
   *   MODEL_GOAL_REACHED != RUN_COMPLETED
   *
   * Verifies that all required verification specifications in the bound MissionContract
   * have executed and succeeded based strictly on durable Action and Attempt state
   * in SQLite.
   */
  /**
   * Authoritative completion evaluation (MODEL_GOAL_REACHED != RUN_COMPLETED). Fail closed:
   *  - no verification specifications => never verified (unverifiable) unless the explicit operator opt-in is set;
   *  - a CLEAN_ROOM_DUAL_GATE spec is satisfied only by a VERIFIED independent clean-room outcome; a missing
   *    verifier or workspace is unverifiable, and an unevaluated one is pending, never passed;
   *  - an unsupported rule kind is unverifiable;
   *  - verified only when every specification produced exactly one VERIFIED result.
   */
  private evaluateCompletionVerification(
    runId: string,
    contract: MissionContract,
    context: CompletionEvaluationContext
  ): CompletionEvaluation {
    if (context.leaseFencing) {
      const activeRun = this.stateStore.getRun(runId);
      if (
        !activeRun ||
        activeRun.leaseId !== context.leaseFencing.leaseId ||
        activeRun.currentWorkerId !== context.leaseFencing.workerId ||
        (activeRun.leaseExpiresAt && this.clock.nowIso() >= activeRun.leaseExpiresAt)
      ) {
        return {
          verified: false,
          leaseLost: true,
          failureReason: `Worker lease authority lost for run '${runId}' prior to completion verification`,
          specResults: [],
        };
      }
    }
    try {
      return this.evaluateCompletionVerificationCore(runId, contract, context);
    } catch (err: unknown) {
      if (err instanceof LeaseLostError || err instanceof LeaseExpiredError) {
        return {
          verified: false,
          leaseLost: true,
          failureReason: err.message,
          specResults: [],
        };
      }
      throw err;
    }
  }

  private evaluateCompletionVerificationCore(
    runId: string,
    contract: MissionContract,
    context: CompletionEvaluationContext
  ): CompletionEvaluation {
    const vSpecs = contract.spec.verificationSpecs;
    if (!vSpecs || vSpecs.length === 0) {
      if (this.allowUnverifiedCompletion) {
        return {
          verified: true,
          specResults: [],
          requirementsSummary: {},
          outstandingRequirements: [],
        };
      }
      return {
        verified: false,
        unverifiable: true,
        rejectionCode: "NO_VERIFICATION_SPECS",
        failureReason: "The Mission Contract declares no verification specifications; an empty set is not proof of completion.",
        specResults: [],
        requirementsSummary: { "verification specifications": "none declared" },
        outstandingRequirements: ["verification specifications: none declared"],
      };
    }

    let cleanRoomPending = false;
    const actions = this.stateStore.getActionsForRun(runId);
    const specResults: VerificationResult[] = [];
    const requirementsSummary: Record<string, string> = {};
    const outstandingRequirements: string[] = [];

    // Pre-evaluate requirement statuses to provide complete feedback
    for (const spec of vSpecs) {
      const expected = spec.expectedValue as Record<string, unknown> | undefined;

      if (expected?.requireMutation) {
        const hasSuccessfulWrite = actions.some((a) => {
          if (a.toolName !== "write_file") return false;
          const attempts = this.stateStore.getAttemptsForAction(a.actionId);
          return attempts.some((att) => att.status === "SUCCEEDED");
        });
        requirementsSummary["required mutation"] = hasSuccessfulWrite
          ? "satisfied"
          : "missing";
        if (
          !hasSuccessfulWrite &&
          !outstandingRequirements.includes("required mutation: write_file")
        ) {
          outstandingRequirements.push("required mutation: write_file");
        }
      }

      if (expected?.requireDiff) {
        const hasSuccessfulDiff = actions.some((a) => {
          if (a.toolName !== "git_diff") return false;
          const attempts = this.stateStore.getAttemptsForAction(a.actionId);
          return attempts.some((att) => att.status === "SUCCEEDED");
        });
        requirementsSummary["required diff inspection"] = hasSuccessfulDiff
          ? "satisfied"
          : "missing";
        if (
          !hasSuccessfulDiff &&
          !outstandingRequirements.includes("required diff inspection: git_diff")
        ) {
          outstandingRequirements.push("required diff inspection: git_diff");
        }
      }

      if (spec.ruleKind === "EXIT_CODE_ZERO") {
        if (!context.workspaceAvailable) {
          const failureResult: VerificationResult = Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds: [],
            reasonCode: "MISSING_EVIDENCE",
            message: "Verification rule 'EXIT_CODE_ZERO' requires an agent workspace, but workspace is unavailable.",
            details: Object.freeze({
              runId,
              taskId: contract.spec.taskId,
              tenantId: (contract.spec as any).tenantId ?? contract.spec.policy?.tenantId ?? "tenant-default",
              contractId: contract.spec.contractId,
              contractVersion: contract.spec.version,
              specId: spec.specId,
              actionId: "none",
              attemptId: "none",
              attemptNumber: 0,
              provenance: "SYSTEM_VERIFICATION",
            }),
            verifiedAt: this.clock.nowIso(),
          });
          const dedupToken = `verification:${runId}:${contract.spec.version}:${spec.specId}:no_workspace`;
          this.coordinator.recordVerificationResult(runId, failureResult, dedupToken, context.leaseFencing);
          return {
            verified: false,
            failureReason: failureResult.message,
            specResults: [...specResults, failureResult],
            requirementsSummary,
            outstandingRequirements,
          };
        }

        const targetTool = (expected?.toolName as string) ?? "run_command";
        const targetArgv = Array.isArray(expected?.argv)
          ? (expected!.argv as readonly string[])
          : undefined;

        const matchingActions = actions.filter((a) => {
          if (a.toolName !== targetTool) return false;
          if (targetArgv) {
            const inputArgv = (a.inputPayload as any)?.argv;
            if (!Array.isArray(inputArgv)) return false;
            if (inputArgv.length !== targetArgv.length) return false;
            return inputArgv.every((v, i) => v === targetArgv[i]);
          }
          return true;
        });

        let testPassed = false;
        if (matchingActions.length > 0) {
          const latestAction = matchingActions[matchingActions.length - 1];
          if (latestAction) {
            const attempts = this.stateStore.getAttemptsForAction(
              latestAction.actionId
            );
            const latestAttempt =
              attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
            if (latestAttempt) {
              const exitCode =
                latestAttempt.exitCode !== null &&
                latestAttempt.exitCode !== undefined
                  ? latestAttempt.exitCode
                  : (latestAttempt.outputPayload as any)?.exitCode !== undefined
                  ? (latestAttempt.outputPayload as any).exitCode
                  : null;
              testPassed = exitCode === 0;
            }
          }
        }

        requirementsSummary["required EXIT_CODE_ZERO verification"] = testPassed
          ? "satisfied"
          : "missing";
        const desc = `required EXIT_CODE_ZERO verification: ${targetTool}${
          targetArgv ? " " + JSON.stringify(targetArgv) : ""
        }`;
        if (!testPassed && !outstandingRequirements.includes(desc)) {
          outstandingRequirements.push(desc);
        }
      }
    }

    for (const spec of vSpecs) {
      const expected = spec.expectedValue as Record<string, unknown> | undefined;

      // 1. Check optional prerequisite: source mutation (write_file)
      if (expected?.requireMutation) {
        const hasSuccessfulWrite = actions.some((a) => {
          if (a.toolName !== "write_file") return false;
          const attempts = this.stateStore.getAttemptsForAction(a.actionId);
          return attempts.some((att) => att.status === "SUCCEEDED");
        });
        if (!hasSuccessfulWrite) {
          const failureResult: VerificationResult = Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds: [],
            reasonCode: "MISSING_EVIDENCE",
            message:
              "Prerequisite source mutation was not performed (no successful 'write_file' found).",
            details: Object.freeze({
              contractId: contract.spec.contractId,
              contractVersion: contract.spec.version,
              actionId: "none",
              attemptId: "none",
              attemptNumber: 0,
            }),
            verifiedAt: this.clock.nowIso(),
          });
          this.coordinator.recordVerificationResult(runId, failureResult, undefined, context.leaseFencing);
          return {
            verified: false,
            failureReason: failureResult.message,
            specResults: [...specResults, failureResult],
            requirementsSummary,
            outstandingRequirements,
          };
        }
      }

      // 2. Check optional prerequisite: diff inspection (git_diff)
      if (expected?.requireDiff) {
        const hasSuccessfulDiff = actions.some((a) => {
          if (a.toolName !== "git_diff") return false;
          const attempts = this.stateStore.getAttemptsForAction(a.actionId);
          return attempts.some((att) => att.status === "SUCCEEDED");
        });
        if (!hasSuccessfulDiff) {
          const failureResult: VerificationResult = Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds: [],
            reasonCode: "MISSING_EVIDENCE",
            message:
              "Prerequisite diff inspection was not performed (no successful 'git_diff' found).",
            details: Object.freeze({
              contractId: contract.spec.contractId,
              contractVersion: contract.spec.version,
              actionId: "none",
              attemptId: "none",
              attemptNumber: 0,
            }),
            verifiedAt: this.clock.nowIso(),
          });
          this.coordinator.recordVerificationResult(runId, failureResult, undefined, context.leaseFencing);
          return {
            verified: false,
            failureReason: failureResult.message,
            specResults: [...specResults, failureResult],
            requirementsSummary,
            outstandingRequirements,
          };
        }
      }

      // 3. Rule Kind Evaluation
      if (spec.ruleKind === "CLEAN_ROOM_DUAL_GATE") {
        // Satisfied only by a VERIFIED independent clean-room outcome. Never skipped.
        if (!context.cleanRoomVerifierAvailable) {
          return {
            verified: false,
            unverifiable: true,
            rejectionCode: "CLEAN_ROOM_VERIFIER_UNAVAILABLE",
            failureReason: "Clean-room verification is required but no CleanRoomVerifier is available.",
            specResults,
            requirementsSummary: { ...requirementsSummary, "clean-room verification": "verifier unavailable" },
            outstandingRequirements: [...outstandingRequirements, "clean-room proof: VERIFIER_UNAVAILABLE"],
          };
        }
        if (!context.workspaceAvailable) {
          return {
            verified: false,
            unverifiable: true,
            rejectionCode: "CLEAN_ROOM_WORKSPACE_UNAVAILABLE",
            failureReason: "Clean-room verification is required but no agent workspace is available.",
            specResults,
            requirementsSummary: { ...requirementsSummary, "clean-room verification": "workspace unavailable" },
            outstandingRequirements: [...outstandingRequirements, "clean-room proof: WORKSPACE_UNAVAILABLE"],
          };
        }
        if (!context.cleanRoomOutcome) {
          cleanRoomPending = true;
          continue;
        }
        if (context.cleanRoomOutcome.status !== "VERIFIED" || context.cleanRoomOutcome.verificationResult.status !== "VERIFIED") {
          return {
            verified: false,
            rejectionCode: "CLEAN_ROOM_NOT_VERIFIED",
            failureReason: `Independent clean-room proof failed: ${context.cleanRoomOutcome.message}`,
            specResults: [...specResults, context.cleanRoomOutcome.verificationResult],
            requirementsSummary: { ...requirementsSummary, "clean-room verification": "failed" },
            outstandingRequirements: [...outstandingRequirements, "clean-room proof: FAILED"],
          };
        }
        specResults.push(context.cleanRoomOutcome.verificationResult);
        requirementsSummary["clean-room verification"] = "satisfied";
        continue;
      }

      if (spec.ruleKind === "EXIT_CODE_ZERO") {
        const targetTool = (expected?.toolName as string) ?? "run_command";
        const targetArgv = Array.isArray(expected?.argv)
          ? (expected!.argv as readonly string[])
          : undefined;

        // Find actions matching target verification tool and argv
        const matchingActions = actions.filter((a) => {
          if (a.toolName !== targetTool) return false;
          if (targetArgv) {
            const inputArgv = (a.inputPayload as any)?.argv;
            if (!Array.isArray(inputArgv)) return false;
            if (inputArgv.length !== targetArgv.length) return false;
            return inputArgv.every((v, i) => v === targetArgv[i]);
          }
          return true;
        });

        if (matchingActions.length === 0) {
          const failureResult: VerificationResult = Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds: [],
            reasonCode: "MISSING_EVIDENCE",
            message: `Required verification command '${targetTool}${targetArgv ? " " + JSON.stringify(targetArgv) : ""}' was never executed.`,
            details: Object.freeze({
              runId,
              taskId: contract.spec.taskId,
              tenantId: (contract.spec as any).tenantId ?? contract.spec.policy?.tenantId ?? "tenant-default",
              contractId: contract.spec.contractId,
              contractVersion: contract.spec.version,
              specId: spec.specId,
              actionId: "none",
              attemptId: "none",
              attemptNumber: 0,
              provenance: "SYSTEM_VERIFICATION",
            }),
            verifiedAt: this.clock.nowIso(),
          });
          const dedupToken = `verification:${runId}:${contract.spec.version}:${spec.specId}:missing`;
          this.coordinator.recordVerificationResult(runId, failureResult, dedupToken, context.leaseFencing);
          return {
            verified: false,
            failureReason: failureResult.message,
            specResults: [...specResults, failureResult],
            requirementsSummary,
            outstandingRequirements,
          };
        }

        // Evaluate the latest matching action and its latest attempt
        const latestAction = matchingActions[matchingActions.length - 1];
        if (!latestAction) {
          const failureResult: VerificationResult = Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds: [],
            reasonCode: "MISSING_EVIDENCE",
            message: `Required verification command was not found.`,
            details: Object.freeze({
              runId,
              taskId: contract.spec.taskId,
              tenantId: (contract.spec as any).tenantId ?? contract.spec.policy?.tenantId ?? "tenant-default",
              contractId: contract.spec.contractId,
              contractVersion: contract.spec.version,
              specId: spec.specId,
              actionId: "none",
              attemptId: "none",
              attemptNumber: 0,
              provenance: "SYSTEM_VERIFICATION",
            }),
            verifiedAt: this.clock.nowIso(),
          });
          const dedupToken = `verification:${runId}:${contract.spec.version}:${spec.specId}:missing`;
          this.coordinator.recordVerificationResult(runId, failureResult, dedupToken, context.leaseFencing);
          return {
            verified: false,
            failureReason: failureResult.message,
            specResults: [...specResults, failureResult],
            requirementsSummary,
            outstandingRequirements,
          };
        }

        const attempts = this.stateStore.getAttemptsForAction(latestAction.actionId);
        const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
        if (!latestAttempt) {
          const failureResult: VerificationResult = Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds: [],
            reasonCode: "MISSING_EVIDENCE",
            message: `Verification action '${latestAction.actionId}' has no recorded attempts.`,
            details: Object.freeze({
              runId,
              taskId: contract.spec.taskId,
              tenantId: (contract.spec as any).tenantId ?? contract.spec.policy?.tenantId ?? "tenant-default",
              contractId: contract.spec.contractId,
              contractVersion: contract.spec.version,
              specId: spec.specId,
              actionId: latestAction.actionId,
              attemptId: "none",
              attemptNumber: 0,
              provenance: "SYSTEM_VERIFICATION",
            }),
            verifiedAt: this.clock.nowIso(),
          });
          const dedupToken = `verification:${runId}:${contract.spec.version}:${spec.specId}:${latestAction.actionId}:no_attempt`;
          this.coordinator.recordVerificationResult(runId, failureResult, dedupToken, context.leaseFencing);
          return {
            verified: false,
            failureReason: failureResult.message,
            specResults: [...specResults, failureResult],
            requirementsSummary,
            outstandingRequirements,
          };
        }

        const exitCode =
          latestAttempt.exitCode !== null && latestAttempt.exitCode !== undefined
            ? latestAttempt.exitCode
            : (latestAttempt.outputPayload as any)?.exitCode !== undefined
            ? (latestAttempt.outputPayload as any).exitCode
            : null;

        const evidenceList: Evidence[] = [];
        const exitEvidence = createProcessExitEvidence(
          runId,
          {
            exitCode: typeof exitCode === "number" ? exitCode : null,
            signal: null,
          },
          {
            source: "INDEPENDENT_OBSERVER",
          }
        );
        evidenceList.push(exitEvidence);
        this.coordinator.recordEvidence(runId, exitEvidence, context.leaseFencing);

        if (latestAttempt.outputPayload !== null && latestAttempt.outputPayload !== undefined) {
          const outputEvidence = createOutputPayloadEvidence(runId, latestAttempt.outputPayload);
          evidenceList.push(outputEvidence);
          this.coordinator.recordEvidence(runId, outputEvidence, context.leaseFencing);
        }

        const rawVerificationResult = DeterministicVerifier.verify(
          evidenceList,
          spec,
          this.clock.nowIso()
        );
        const commandHash =
          (latestAttempt.outputPayload as any)?.commandHash ??
          computeCanonicalHash(targetArgv ?? targetTool).contentHash;
        const verificationResult: VerificationResult = Object.freeze({
          ...rawVerificationResult,
          details: Object.freeze({
            ...(rawVerificationResult.details ?? {}),
            runId,
            taskId: contract.spec.taskId,
            tenantId: (contract.spec as any).tenantId ?? contract.spec.policy?.tenantId ?? "tenant-default",
            contractId: contract.spec.contractId,
            contractVersion: contract.spec.version,
            specId: spec.specId,
            actionId: latestAction.actionId,
            attemptId: latestAttempt.attemptId,
            attemptNumber: latestAttempt.attemptNumber,
            commandHash,
            exitCode: typeof exitCode === "number" ? exitCode : null,
            executionOutcome: latestAttempt.status,
            provenance: "SYSTEM_VERIFICATION",
          }),
        });
        const dedupToken = `verification:${runId}:${contract.spec.version}:${spec.specId}:${latestAction.actionId}`;
        this.coordinator.recordVerificationResult(runId, verificationResult, dedupToken, context.leaseFencing);
        specResults.push(verificationResult);

        if (verificationResult.status !== "VERIFIED") {
          return {
            verified: false,
            failureReason: `Verification rule 'EXIT_CODE_ZERO' failed: ${verificationResult.message}`,
            specResults,
            requirementsSummary,
            outstandingRequirements,
          };
        }
      } else if (spec.ruleKind === "EXACT_OUTPUT_MATCH" || spec.ruleKind === "OUTPUT_HASH_MATCH") {
        // Output-evidence rules
        const lastAction = actions[actions.length - 1];
        const attempts = lastAction ? this.stateStore.getAttemptsForAction(lastAction.actionId) : [];
        const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;

        const evidenceList: Evidence[] = [];
        if (latestAttempt?.outputPayload !== null && latestAttempt?.outputPayload !== undefined) {
          const outputEvidence = createOutputPayloadEvidence(runId, latestAttempt.outputPayload);
          evidenceList.push(outputEvidence);
          this.coordinator.recordEvidence(runId, outputEvidence, context.leaseFencing);
        }

        const rawVerificationResult = DeterministicVerifier.verify(
          evidenceList,
          spec,
          this.clock.nowIso()
        );
        const verificationResult: VerificationResult = Object.freeze({
          ...rawVerificationResult,
          details: Object.freeze({
            ...(rawVerificationResult.details ?? {}),
            runId,
            taskId: contract.spec.taskId,
            tenantId: (contract.spec as any).tenantId ?? contract.spec.policy?.tenantId ?? "tenant-default",
            contractId: contract.spec.contractId,
            contractVersion: contract.spec.version,
            specId: spec.specId,
            actionId: lastAction?.actionId ?? "none",
            attemptId: latestAttempt?.attemptId ?? "none",
            attemptNumber: latestAttempt?.attemptNumber ?? 0,
            executionOutcome: latestAttempt?.status ?? "UNKNOWN",
            provenance: "SYSTEM_VERIFICATION",
          }),
        });
        const dedupToken = `verification:${runId}:${contract.spec.version}:${spec.specId}:${lastAction?.actionId ?? "none"}`;
        this.coordinator.recordVerificationResult(runId, verificationResult, dedupToken, context.leaseFencing);
        specResults.push(verificationResult);

        if (verificationResult.status !== "VERIFIED") {
          return {
            verified: false,
            failureReason: `Verification rule '${spec.ruleKind}' failed: ${verificationResult.message}`,
            specResults,
            requirementsSummary,
            outstandingRequirements,
          };
        }
      } else {
        // Unsupported or unhandled rule kind: never treated as satisfied.
        return {
          verified: false,
          unverifiable: true,
          rejectionCode: "UNSUPPORTED_VERIFICATION_RULE",
          failureReason: `Verification rule '${String((spec as { ruleKind?: unknown }).ruleKind)}' is not supported by the completion gate.`,
          specResults,
          requirementsSummary: { ...requirementsSummary, "verification rule": "unsupported" },
          outstandingRequirements: [...outstandingRequirements, "verification rule: unsupported"],
        };
      }
    }

    if (cleanRoomPending) {
      return {
        verified: false,
        cleanRoomPending: true,
        rejectionCode: "CLEAN_ROOM_NOT_EVALUATED",
        failureReason: "Independent clean-room verification has not yet been evaluated.",
        specResults,
        requirementsSummary: { ...requirementsSummary, "clean-room verification": "not yet evaluated" },
        outstandingRequirements: [...outstandingRequirements, "clean-room proof: NOT_EVALUATED"],
      };
    }

    // An empty or partial result set is never success: every specification needs exactly one VERIFIED result.
    if (specResults.length !== vSpecs.length || !specResults.every((r) => r.status === "VERIFIED")) {
      return {
        verified: false,
        rejectionCode: "MISSING_EVIDENCE",
        failureReason: "Not every required verification specification produced a VERIFIED result.",
        specResults,
        requirementsSummary,
        outstandingRequirements,
      };
    }

    return { verified: true, specResults, requirementsSummary, outstandingRequirements };
  }

  /** Maps an unverified evaluation to a stable, payload-free rejection code. */
  private classifyCompletionRejection(evaluation: CompletionEvaluation): CompletionRejectionCode {
    if (evaluation.rejectionCode) return evaluation.rejectionCode;
    const last = evaluation.specResults[evaluation.specResults.length - 1];
    return last?.reasonCode === "MISSING_EVIDENCE" ? "MISSING_EVIDENCE" : "VERIFICATION_FAILED";
  }

  /**
   * Resolves the primary target file path for the current step from mission context
   * or current residency state.
   */
  private resolveTargetFilePath(contextSnapshot: ContextSnapshot): string | undefined {
    const missionObs = contextSnapshot.observations.find((o) => o.category === "MISSION_CONTEXT");
    const taskDetails = missionObs?.content?.taskDetails as any;
    if (typeof taskDetails?.targetFile === "string" && taskDetails.targetFile.length > 0) {
      return taskDetails.targetFile;
    }
    if (typeof taskDetails?.description === "string") {
      const match = taskDetails.description.match(/Target File:\s*([^\s\r\n,]+)/);
      if (match?.[1]) {
        return match[1];
      }
    }
    const records = this.contextResidencyTracker.listResidencyRecords();
    if (records.length === 1 && records[0] && records[0].isComplete && !records[0].isStale) {
      return records[0].path;
    }
    return undefined;
  }
}
