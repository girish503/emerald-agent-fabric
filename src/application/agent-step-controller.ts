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
import { redactSensitiveData } from "../domain/canonical-hash.js";
import { ContextBudgetExceededError } from "../domain/errors.js";
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
import type { CleanRoomVerifier } from "./clean-room-verifier.js";
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
import { StateStorePort } from "../ports/state-store.port.js";
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
  /** Maximum consecutive ineffective edits failing to pass tests before halting */
  readonly maxConsecutiveIneffectiveEdits?: number;
  /** Whether intermediate test feedback after mutations is enabled */
  readonly enableIntermediateTestFeedback?: boolean;
  /** Whether the post-pass verification latch is enabled */
  readonly enablePostPassVerificationLatch?: boolean;
}

export const DEFAULT_MAX_CONSECUTIVE_IDENTICAL_READS = 3;
export const DEFAULT_MAX_CONSECUTIVE_INEFFECTIVE_EDITS = 3;

export const DEFAULT_STEP_CONTROLLER_BUDGET: StepControllerBudget = Object.freeze({
  maxSteps: 10,
  maxWallClockMs: 60_000,
  maxActions: 10,
  maxConsecutiveFailures: 3,
  maxProposalRejections: 3,
  maxConsecutiveIdenticalReads: DEFAULT_MAX_CONSECUTIVE_IDENTICAL_READS,
  maxConsecutiveIneffectiveEdits: DEFAULT_MAX_CONSECUTIVE_INEFFECTIVE_EDITS,
  enableIntermediateTestFeedback: true,
  enablePostPassVerificationLatch: true,
});

export const MAX_REJECTION_FEEDBACK_CHARS = 512;
export const REPEATED_IDENTICAL_READ_ADVISORY_THRESHOLD = 2;

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
  if (nodeDiffMatch) {
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
    if (vitestExpectedMatch && vitestReceivedMatch) {
      expectedValue = vitestExpectedMatch[1].trim().slice(0, 120);
      actualValue = vitestReceivedMatch[1].trim().slice(0, 120);
      assertionKind = "DIFF_EQUAL";
    } else {
      const toBeMatch = combined.match(/expected\s+([^\r\n]+?)\s+to (?:be|equal)\s+([^\r\n]+)/i);
      if (toBeMatch) {
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
    const rawLine = parseInt(stackMatch[2], 10);

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
          const testCodeLine = lines[testLine - 1].trim();

          // Pattern A: assert.throws
          const throwsMatch = testCodeLine.match(
            /assert\.throws\(\s*(?:\(\)\s*=>\s*|\bfunction\s*\(\)\s*\{\s*(?:return\s*)?)?([\s\S]+?)\s*(?:\}\s*)?\);?$/
          );
          if (throwsMatch) {
            let expr = throwsMatch[1].trim();
            if (expr.endsWith(")") && (expr.match(/\(/g) || []).length < (expr.match(/\)/g) || []).length) {
              expr = expr.slice(0, -1).trim();
            }
            failingExpression = expr.slice(0, 120);
          }

          // Pattern B: expect(expr).to...
          if (!failingExpression) {
            const expectMatch = testCodeLine.match(/expect\(\s*([\s\S]+?)\s*\)\./);
            if (expectMatch) {
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
  | "POLICY_DENIED";

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
  readonly totalProposalRejections: number;
  readonly totalConsecutiveFailures: number;
  readonly totalWallClockMs: number;
  readonly transcript: readonly StepTranscriptEntry[];
  readonly lastContextSnapshot?: ContextSnapshot;
  readonly postPassLatchSnapshot?: PostPassLatchSnapshot;
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
  private readonly speculativePromotionGate?: import("./speculative-promotion-gate.js").SpeculativePromotionGate;
  private readonly speculativePolicy?: import("./runtime-speculative-execution-policy.js").RuntimeSpeculativeExecutionPolicy;
  private readonly enableDynamicToolFiltering: boolean;
  private readonly contextResidencyTracker: ContextResidencyTracker;
  private readonly failedAnchorTracker: FailedAnchorTracker;
  private readonly duplicateProposalDetector: DuplicateProposalDetector;
  private readonly postPassLatch: PostPassVerificationLatch;

  constructor(options: AgentStepControllerOptions) {
    this.coordinator = options.coordinator;
    this.stateStore = options.stateStore;
    this.workerRuntime = options.workerRuntime;
    this.agentBrain = options.agentBrain;
    this.toolRegistry = options.toolRegistry ?? defaultGovernedToolRegistry;
    this.clock = options.clock ?? new SystemClock();
    this.reflex = options.reflex ?? new NoopReflex();
    this.enableGovernedVerificationStage =
      options.enableGovernedVerificationStage ?? false;
    this.cleanRoomVerifier = options.cleanRoomVerifier;
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
    const transcript: StepTranscriptEntry[] = [];
    let stepCount = 0;
    let actionCount = 0;
    let consecutiveFailures = 0;
    let proposalRejections = 0;
    let lastContextSnapshot: ContextSnapshot | undefined;
    let pendingProposalRejectionObservation: Observation | null = null;
    let pendingProgressAdvisoryObservation: Observation | null = null;
    let pendingTestFeedbackObservation: Observation | null = null;
    let pendingActionRecoveryObservation: Observation | null = null;
    let consecutiveIdenticalReads = 0;
    let consecutiveIneffectiveEdits = 0;
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

    // Helper to assemble final StepControllerResult
    const assembleResult = (
      reason: StepControllerTerminalReason,
      message: string,
      taskId: string
    ): StepControllerResult => {
      const totalWallClockMs = this.clock.now().getTime() - startTime;
      return Object.freeze({
        runId,
        taskId,
        terminalReason: reason,
        terminalMessage: message,
        totalSteps: stepCount,
        totalActions: actionCount,
        totalProposalRejections: proposalRejections,
        totalConsecutiveFailures: consecutiveFailures,
        totalWallClockMs,
        transcript: Object.freeze([...transcript]),
        ...(lastContextSnapshot ? { lastContextSnapshot } : {}),
        postPassLatchSnapshot: this.postPassLatch.getSnapshot(),
      });
    };

    // Initial pre-loop authoritative validation
    const initialRun = this.stateStore.getRun(runId);
    if (!initialRun) {
      return assembleResult("LEASE_LOST", `Run '${runId}' not found in state store`, "unknown");
    }
    const taskId = initialRun.taskId;

    // ------------------------------------------------------------------------
    // The Autonomous Step Loop
    // ------------------------------------------------------------------------
    while (true) {
      const nowMs = this.clock.now().getTime();
      const elapsedMs = nowMs - startTime;

      // 1. Check Cancellation
      if (params.abortSignal?.aborted) {
        return assembleResult("CANCELLED", "Autonomous loop aborted by AbortSignal", taskId);
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

      // 4. Check Action Budget
      if (actionCount >= effectiveBudget.maxActions) {
        return assembleResult(
          "MAX_ACTIONS",
          `Maximum action execution ceiling reached (${actionCount} >= ${effectiveBudget.maxActions})`,
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
      if (consecutiveIdenticalReads >= maxConsecutiveIdenticalReads) {
        return assembleResult(
          "STAGNATION",
          `Execution loop halted due to stagnation: ${consecutiveIdenticalReads} consecutive identical successful reads of '${lastSuccessfulRead?.path ?? "unknown"}' without progress`,
          taskId
        );
      }

      // 7b. Check Stagnation (Consecutive Ineffective Edits) Budget
      const maxConsecutiveIneffectiveEdits =
        effectiveBudget.maxConsecutiveIneffectiveEdits ??
        DEFAULT_MAX_CONSECUTIVE_INEFFECTIVE_EDITS;
      if (consecutiveIneffectiveEdits >= maxConsecutiveIneffectiveEdits) {
        return assembleResult(
          "STAGNATION",
          `Execution loop halted due to stagnation: ${consecutiveIneffectiveEdits} consecutive ineffective edit attempts failed to produce passing test results`,
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

      // Step A: Build Authoritative ContextSnapshot
      let contextSnapshot: ContextSnapshot;
      try {
        const candidates = await this.contextSource.gatherCandidateObservations(runId);
        const effectiveCandidates = [
          ...candidates,
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
      } catch (err: unknown) {
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
        // Authoritative Physical Verification Completion Gate (Phase 13B)
        // MODEL_GOAL_REACHED != RUN_COMPLETED
        // isGoalReached: true is strictly an untrusted model proposal.
        let verificationEvaluation = this.evaluateCompletionVerification(
          runId,
          contract
        );

        // Phase 13D: Governed Verification Stage Experiment
        const isVerificationStageEnabled =
          params.enableGovernedVerificationStage ??
          this.enableGovernedVerificationStage ??
          (contract.spec.verificationSpecs ?? []).some(
            (s) => (s.expectedValue as any)?.governedStage === true
          );

        if (!verificationEvaluation.verified && isVerificationStageEnabled) {
          const stageResult = await this.executeGovernedVerificationStage({
            runId,
            taskId,
            contract,
            workerId,
            leaseId,
            workspace: params.workspace,
            abortSignal: params.abortSignal,
            effectiveBudget,
            currentActionCount: actionCount,
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

          actionCount = stageResult.updatedActionCount;
          consecutiveFailures = stageResult.updatedConsecutiveFailures;
          replayBlockCount = stageResult.updatedReplayBlockCount;
          if (stageResult.replayFeedback) {
            pendingActionRecoveryObservation = stageResult.replayFeedback;
          }

          if (stageResult.terminalResult) {
            return stageResult.terminalResult;
          }

          // Re-evaluate verification after executing contract-declared verification stage
          verificationEvaluation = this.evaluateCompletionVerification(
            runId,
            contract
          );
        }

        // Phase 14: Independent Clean-Room Verification
        const cleanRoomSpecObj = (contract.spec.verificationSpecs ?? []).find(
          (s) => s.ruleKind === "CLEAN_ROOM_DUAL_GATE"
        );
        if (
          verificationEvaluation.verified &&
          cleanRoomSpecObj &&
          this.cleanRoomVerifier &&
          params.workspace
        ) {
          const cleanSpec = cleanRoomSpecObj.expectedValue as CleanRoomVerificationSpec;
          const cleanRoomOutcome = await this.cleanRoomVerifier.verifyCandidatePatch({
            runId,
            taskId,
            workerId,
            leaseId,
            contract,
            spec: cleanSpec,
            agentWorkspace: params.workspace,
            abortSignal: params.abortSignal,
          });

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
          }
        }

        if (!verificationEvaluation.verified) {
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

        // Verified goal reached: physical verification invariant satisfied
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
          actionsExecuted: actionCount,
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

      // Pre-Execution Action Ceiling Check
      if (actionCount >= effectiveBudget.maxActions) {
        return assembleResult(
          "MAX_ACTIONS",
          `Maximum action execution ceiling reached prior to executing Action '${action.actionId}' (${actionCount} >= ${effectiveBudget.maxActions})`,
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
      actionCount++;
      const actionResult = await this.workerRuntime.executeAction({
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
        } catch {
          // Defense in depth
        }
      }

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

            if (classification === "PASS") {
              consecutiveIneffectiveEdits = 0;
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
                          activeContract
                        );
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
    readonly currentActionCount: number;
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
    readonly updatedActionCount: number;
    readonly updatedConsecutiveFailures: number;
    readonly updatedReplayBlockCount: number;
    readonly replayFeedback?: Observation | null;
    readonly terminalResult?: StepControllerResult;
  }> {
    let actionCount = params.currentActionCount;
    let consecutiveFailures = params.consecutiveFailures;
    let replayBlockCount = params.replayBlockCount;
    let replayFeedback: Observation | null | undefined;
    const vSpecs = params.contract.spec.verificationSpecs ?? [];
    if (vSpecs.length === 0) {
      return { updatedActionCount: actionCount, updatedConsecutiveFailures: consecutiveFailures, updatedReplayBlockCount: replayBlockCount };
    }

    const actions = this.stateStore.getActionsForRun(params.runId);

    // 1. Check prerequisite mutation requirement
    const requiresMutation = vSpecs.some(
      (s) => (s.expectedValue as Record<string, unknown> | undefined)?.requireMutation
    );

    let lastWriteActionIndex = -1;
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i]!.toolName === "write_file" || actions[i]!.toolName === "edit_file") {
        const attempts = this.stateStore.getAttemptsForAction(actions[i]!.actionId);
        if (attempts.some((att) => att.status === "SUCCEEDED")) {
          lastWriteActionIndex = i;
          break;
        }
      }
    }

    // If mutation is required but no successful write_file exists, do not execute verification stage
    if (requiresMutation && lastWriteActionIndex === -1) {
      return { updatedActionCount: actionCount, updatedConsecutiveFailures: consecutiveFailures, updatedReplayBlockCount: replayBlockCount };
    }

    // 2. Prevent verification loops (Section 16):
    // Check if verification already executed on the current code state and failed
    const actionsAfterLastWrite = lastWriteActionIndex >= 0 ? actions.slice(lastWriteActionIndex + 1) : actions;
    const alreadyTestedAfterMutation = actionsAfterLastWrite.some((a) => {
      if (a.toolName !== "run_command") return false;
      const attempts = this.stateStore.getAttemptsForAction(a.actionId);
      const latestAttempt = attempts[attempts.length - 1];
      if (!latestAttempt) return false;
      const exitCode =
        latestAttempt.exitCode !== null && latestAttempt.exitCode !== undefined
          ? latestAttempt.exitCode
          : (latestAttempt.outputPayload as any)?.exitCode !== undefined
          ? (latestAttempt.outputPayload as any).exitCode
          : null;
      return exitCode !== null && exitCode !== 0;
    });

    if (alreadyTestedAfterMutation) {
      // Verification already ran on this exact mutation state and failed; do not loop without code changes
      return { updatedActionCount: actionCount, updatedConsecutiveFailures: consecutiveFailures, updatedReplayBlockCount: replayBlockCount };
    }

    // 3. Determine verification actions to execute
    interface VerificationActionTask {
      readonly toolName: ToolName;
      readonly inputPayload: unknown;
    }

    const tasksToExecute: VerificationActionTask[] = [];

    // 3a. Diff requirement
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
        });
      }
    }

    // 3b. Test command requirements (EXIT_CODE_ZERO)
    for (const spec of vSpecs) {
      if (spec.ruleKind === "EXIT_CODE_ZERO") {
        const expected = spec.expectedValue as Record<string, unknown> | undefined;
        const targetTool = ((expected?.toolName as string) ?? "run_command") as ToolName;
        const targetArgv = Array.isArray(expected?.argv)
          ? (expected!.argv as readonly string[])
          : undefined;

        const hasTestAfterMutation = actionsAfterLastWrite.some((a) => {
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

        if (!hasTestAfterMutation) {
          tasksToExecute.push({
            toolName: targetTool,
            inputPayload: {
              ...(targetArgv ? { argv: targetArgv } : {}),
              timeoutMs: Math.min(60000, params.contract.spec.resourceLimits.timeoutMs),
            },
          });
        }
      }
    }

    // 4. Sequentially execute required verification actions through WorkerRuntime
    for (const task of tasksToExecute) {
      // Check cancellation
      if (params.abortSignal?.aborted) {
        return {
          updatedActionCount: actionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "CANCELLED",
            `Autonomous loop aborted by AbortSignal prior to verification action '${task.toolName}'`
          ),
        };
      }

      // Check wall-clock budget
      const elapsedMs = this.clock.now().getTime() - params.startTime;
      if (elapsedMs >= params.effectiveBudget.maxWallClockMs) {
        return {
          updatedActionCount: actionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "MAX_WALL_CLOCK",
            `Wall clock ceiling reached prior to verification action '${task.toolName}' (${elapsedMs}ms >= ${params.effectiveBudget.maxWallClockMs}ms)`
          ),
        };
      }

      // Check action ceiling
      if (actionCount >= params.effectiveBudget.maxActions) {
        return {
          updatedActionCount: actionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "MAX_ACTIONS",
            `Maximum action execution ceiling reached prior to verification action '${task.toolName}' (${actionCount} >= ${params.effectiveBudget.maxActions})`
          ),
        };
      }

      // Check lease ownership & expiration
      const preExecRun = this.stateStore.getRun(params.runId);
      if (!preExecRun || preExecRun.leaseId !== params.leaseId || preExecRun.currentWorkerId !== params.workerId) {
        return {
          updatedActionCount: actionCount,
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
          updatedActionCount: actionCount,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedReplayBlockCount: replayBlockCount,
          terminalResult: params.assembleResult(
            "LEASE_LOST",
            `Lease expired prior to executing verification action '${task.toolName}' (expired at '${preExecRun.leaseExpiresAt}')`
          ),
        };
      }

      // Execute via governed WorkerRuntime pipeline
      actionCount++;
      const actionStart = this.clock.now().getTime();
      const actionTimestamp = this.clock.nowIso();

      const actionResult = await this.workerRuntime.executeAction({
        runId: params.runId,
        toolName: task.toolName,
        inputPayload: task.inputPayload,
        leaseId: params.leaseId,
        workspace: params.workspace,
        timeoutMs: params.contract.spec.resourceLimits.timeoutMs,
        maxOutputBytes: params.contract.spec.resourceLimits.maxOutputBytes,
        abortSignal: params.abortSignal,
      });

      params.transcript.push(
        Object.freeze({
          stepNumber: params.stepCount,
          contextSnapshotId: params.contextSnapshot.snapshotId,
          contextHash: params.contextSnapshot.contextHash,
          contextEstimatedTokens: params.contextSnapshot.totalEstimatedTokens,
          contextBytes: params.contextSnapshot.totalBytes,
          contextObservationsCount: params.contextSnapshot.observations.length,
          toolName: task.toolName,
          inputPayload: task.inputPayload,
          rationale: "Contract-declared verification stage execution",
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
          updatedActionCount: actionCount,
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
          updatedActionCount: actionCount,
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
          updatedActionCount: actionCount,
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
            updatedActionCount: actionCount,
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
      updatedActionCount: actionCount,
      updatedConsecutiveFailures: consecutiveFailures,
      updatedReplayBlockCount: replayBlockCount,
      ...(replayFeedback !== undefined ? { replayFeedback } : {}),
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
  private evaluateCompletionVerification(
    runId: string,
    contract: MissionContract
  ): {
    readonly verified: boolean;
    readonly failureReason?: string;
    readonly specResults: readonly VerificationResult[];
    readonly requirementsSummary?: Record<string, string>;
    readonly outstandingRequirements?: readonly string[];
  } {
    const vSpecs = contract.spec.verificationSpecs;
    if (!vSpecs || vSpecs.length === 0) {
      return {
        verified: true,
        specResults: [],
        requirementsSummary: {},
        outstandingRequirements: [],
      };
    }

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
            verifiedAt: this.clock.nowIso(),
          });
          this.coordinator.recordVerificationResult(runId, failureResult);
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
            verifiedAt: this.clock.nowIso(),
          });
          this.coordinator.recordVerificationResult(runId, failureResult);
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
        // Independent clean-room dual-gate is evaluated by CleanRoomVerifier in completion stage
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
            verifiedAt: this.clock.nowIso(),
          });
          this.coordinator.recordVerificationResult(runId, failureResult);
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
            verifiedAt: this.clock.nowIso(),
          });
          this.coordinator.recordVerificationResult(runId, failureResult);
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
            verifiedAt: this.clock.nowIso(),
          });
          this.coordinator.recordVerificationResult(runId, failureResult);
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
        const exitEvidence = createProcessExitEvidence(runId, {
          exitCode: typeof exitCode === "number" ? exitCode : null,
          signal: null,
        });
        evidenceList.push(exitEvidence);
        this.coordinator.recordEvidence(runId, exitEvidence);

        if (latestAttempt.outputPayload !== null && latestAttempt.outputPayload !== undefined) {
          const outputEvidence = createOutputPayloadEvidence(runId, latestAttempt.outputPayload);
          evidenceList.push(outputEvidence);
          this.coordinator.recordEvidence(runId, outputEvidence);
        }

        const verificationResult = DeterministicVerifier.verify(
          evidenceList,
          spec,
          this.clock.nowIso()
        );
        this.coordinator.recordVerificationResult(runId, verificationResult);
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
      } else {
        // Fallback for EXACT_OUTPUT_MATCH or OUTPUT_HASH_MATCH
        const lastAction = actions[actions.length - 1];
        const attempts = lastAction ? this.stateStore.getAttemptsForAction(lastAction.actionId) : [];
        const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;

        const evidenceList: Evidence[] = [];
        if (latestAttempt?.outputPayload !== null && latestAttempt?.outputPayload !== undefined) {
          const outputEvidence = createOutputPayloadEvidence(runId, latestAttempt.outputPayload);
          evidenceList.push(outputEvidence);
          this.coordinator.recordEvidence(runId, outputEvidence);
        }

        const verificationResult = DeterministicVerifier.verify(
          evidenceList,
          spec,
          this.clock.nowIso()
        );
        this.coordinator.recordVerificationResult(runId, verificationResult);
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
      }
    }

    return { verified: true, specResults, requirementsSummary, outstandingRequirements };
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
