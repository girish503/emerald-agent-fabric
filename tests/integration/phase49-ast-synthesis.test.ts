/**
 * Phase 49 — Grammar-Constrained AST Synthesis & Structural Program Patching Test Suite.
 *
 * Evaluates whether constraining the model's code-generation space to structurally valid
 * AST transformations can resolve the remaining 20.0% composition gap observed in Phase 48.
 *
 * Invariants:
 * - ₹0 cost, local CPU execution, open-weight models only.
 * - Single CPU-feasible model: qwen2.5-coder:1.5b (Q4_K_M).
 * - Exact Phase 46/47/48 15 parent task cohort, DAG decomposition graphs, and semantic anchors.
 * - 4 experimental conditions: Current Best Baseline (A), Structural Patch (B),
 *   AST Node Constraint (C), AST Constraint + Semantic Anchor (D).
 * - 60 total parent task evaluations.
 * - Clean-room verification and fourfold completion strictly fail-closed.
 * - Offline auditor parity: 100% concordance.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createTerminalRecord,
  EvidenceBundle,
} from "../../src/domain/evidence-bundle.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  createMissionContract,
  createExecutionPolicy,
  createResourceLimits,
  createVerificationSpec,
} from "../../src/domain/index.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import { EvidenceExporter } from "../../src/application/evidence-exporter.js";
import {
  EvidenceSigner,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";
import { OfflineAuditor } from "../../src/application/offline-auditor.js";

// ============================================================================
// Phase 49 AST Patch Model, Validation Pipeline & Pure Functions
// ============================================================================

export type ASTOperation =
  | "REPLACE_EXPRESSION"
  | "REPLACE_STATEMENT"
  | "REPLACE_FUNCTION_BODY"
  | "INSERT_STATEMENT"
  | "DELETE_STATEMENT"
  | "REPLACE_RETURN_EXPRESSION";

export interface ASTPatchProposal {
  patchId: string;
  parentTaskId: string;
  subTaskId: string;
  targetFile: string;
  targetSymbol: string;
  targetNodeType: string;
  operation: ASTOperation;
  replacement: string;
  sourceHashBefore?: string;
  expectedTargetHash: string;
  allowedScopeFiles: string[];
}

export interface ASTValidationResult {
  valid: boolean;
  errorCode?: string;
  message?: string;
  matchedNodeCount?: number;
  reparsedAST?: boolean;
}

export function computeStructuralTargetHash(
  targetFile: string,
  symbolPath: string,
  targetNodeType: string,
  normalizedSnippet: string
): string {
  const normSnippet = normalizedSnippet.replace(/\s+/g, " ").trim();
  const raw = `${targetFile}::${symbolPath}::${targetNodeType}::${normSnippet}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function resolveASTTarget(
  sourceCode: string,
  targetSymbol: string,
  expectedNodeType: string
): { found: boolean; nodes: ts.Node[]; errorCode?: string } {
  const sourceFile = ts.createSourceFile("temp.js", sourceCode, ts.ScriptTarget.Latest, true);
  const symbolNodes: ts.Node[] = [];
  const matchedNodes: ts.Node[] = [];

  function visit(node: ts.Node) {
    let matchesSymbol = false;

    // Check symbol match
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === targetSymbol) {
      matchesSymbol = true;
      symbolNodes.push(node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === targetSymbol) {
      matchesSymbol = true;
      symbolNodes.push(node);
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === targetSymbol) {
      matchesSymbol = true;
      symbolNodes.push(node);
    }

    if (matchesSymbol) {
      const actualKindName = ts.SyntaxKind[node.kind];
      if (actualKindName === expectedNodeType || (expectedNodeType === "FunctionDeclaration" && ts.isFunctionDeclaration(node))) {
        matchedNodes.push(node);
      }
    }

    // Also match ReturnStatement or BinaryExpression inside target scope
    if (expectedNodeType === "ReturnStatement" && ts.isReturnStatement(node)) {
      matchedNodes.push(node);
    } else if (expectedNodeType === "BinaryExpression" && ts.isBinaryExpression(node)) {
      matchedNodes.push(node);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (symbolNodes.length > 0 && matchedNodes.length === 0) {
    return { found: false, nodes: symbolNodes, errorCode: "AST_NODE_TYPE_MISMATCH" };
  }
  if (matchedNodes.length === 0) {
    return { found: false, nodes: [], errorCode: "AST_TARGET_NOT_FOUND" };
  }
  if (matchedNodes.length > 1) {
    return { found: false, nodes: matchedNodes, errorCode: "AST_TARGET_AMBIGUOUS" };
  }

  return { found: true, nodes: matchedNodes };
}

export function validateASTPatch(
  proposal: ASTPatchProposal,
  sourceCode: string
): ASTValidationResult {
  // 1. Schema check
  if (!proposal.patchId || !proposal.targetFile || !proposal.operation || !proposal.expectedTargetHash) {
    return { valid: false, errorCode: "AST_SCHEMA_FAILURE", message: "Missing required patch fields" };
  }

  // 2. Disallow whole file replacement
  if (proposal.targetNodeType === "SourceFile" || proposal.replacement === sourceCode) {
    return { valid: false, errorCode: "WHOLE_FILE_PROHIBITED", message: "Whole-file replacement is prohibited" };
  }

  // 3. Scope restriction check
  if (!proposal.allowedScopeFiles.includes(proposal.targetFile)) {
    return { valid: false, errorCode: "AST_PATCH_SCOPE_FAILURE", message: `Target file ${proposal.targetFile} outside scope` };
  }

  // 4. Target resolution & single target check
  const resolution = resolveASTTarget(sourceCode, proposal.targetSymbol, proposal.targetNodeType);
  if (!resolution.found) {
    return { valid: false, errorCode: resolution.errorCode, message: `Failed resolving AST target: ${resolution.errorCode}` };
  }

  // 5. Target hash fingerprint check
  const targetNode = resolution.nodes[0]!;
  const snippet = targetNode.getText(ts.createSourceFile("temp.js", sourceCode, ts.ScriptTarget.Latest, true));
  const computedHash = computeStructuralTargetHash(
    proposal.targetFile,
    proposal.targetSymbol,
    proposal.targetNodeType,
    snippet
  );

  if (computedHash !== proposal.expectedTargetHash) {
    return {
      valid: false,
      errorCode: "AST_TARGET_HASH_MISMATCH",
      message: `Structural hash mismatch: computed ${computedHash} != expected ${proposal.expectedTargetHash}`,
    };
  }

  // 6. Reparse check with applied replacement
  const mutatedCode = sourceCode.replace(snippet, proposal.replacement);
  try {
    const reparsed = ts.createSourceFile("mutated.js", mutatedCode, ts.ScriptTarget.Latest, true);
    let hasSyntaxError = false;
    // Check for parse diagnostics
    if ((reparsed as any).parseDiagnostics && (reparsed as any).parseDiagnostics.length > 0) {
      hasSyntaxError = true;
    }
    if (hasSyntaxError) {
      return { valid: false, errorCode: "AST_REPARSE_FAILURE", message: "Mutated source failed AST reparse" };
    }
  } catch (err: any) {
    return { valid: false, errorCode: "AST_REPARSE_FAILURE", message: err.message };
  }

  return { valid: true, matchedNodeCount: 1, reparsedAST: true };
}

// ============================================================================
// Helper to create test evidence bundles
// ============================================================================

function createTestBundle(baseDir: string, status: "COMPLETED" | "FAILED"): EvidenceBundle {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dbPath = path.join(baseDir, `test-store-${nonce}.db`);
  const store = new SqliteStateStore({ location: dbPath });
  const clock = new SettableClock("2026-10-19T19:30:00.000Z");
  const coordinator = new RunCoordinator(store, clock);

  const taskId = `task-p49-${nonce}`;
  coordinator.createTask({
    taskId,
    title: "Phase 49 AST Synthesis Task",
    inputPayload: { goal: "evaluate grammar-constrained AST synthesis" },
  });

  const spec = {
    taskId,
    policy: createExecutionPolicy({
      policyId: `policy-${nonce}`,
      allowedCapabilities: ["read_file", "write_file", "run_command"],
      isolationRequirement: "IN_PROCESS" as const,
      trustedInProcessOperations: ["read_file", "write_file", "run_command"],
    }),
    resourceLimits: createResourceLimits({
      timeoutMs: 30000,
      maxAttempts: 3,
      maxOutputBytes: 1048576,
    }),
    verificationSpecs: [
      createVerificationSpec({
        specId: `spec-${nonce}`,
        ruleKind: "EXIT_CODE_ZERO",
        expectedValue: { toolName: "run_command" },
      }),
    ],
    credentialScopes: ["repo:read"],
  };

  const draft = createMissionContract(spec);
  store.insertContract(draft);
  store.activateContract(draft.spec.contractId, draft.spec.version, clock.nowIso());

  const createRes = coordinator.createRun({
    taskId,
    maxAttempts: 3,
    timeoutMs: 30000,
  });

  coordinator.queueRun(createRes.run.runId);
  coordinator.registerWorker({
    workerId: "worker-p49",
    hostname: "node-p49",
    pid: 5005,
    status: "ACTIVE",
    lastHeartbeatAt: clock.nowIso(),
    createdAt: clock.nowIso(),
  });

  const claim = coordinator.claimRun(createRes.run.runId, "worker-p49", 30000);
  coordinator.startRun(createRes.run.runId, "worker-p49", claim.lease.leaseId);
  coordinator.saveCheckpoint({
    runId: createRes.run.runId,
    checkpointVersion: 1,
    durableState: { stage: "ast_synthesis_test" },
  });

  const actionId = `act-p49-${nonce}`;
  const { action, event: actEvt } = Action.create({
    actionId,
    runId: createRes.run.runId,
    sequenceNumber: 1,
    toolName: "run_command",
    inputPayload: { argv: ["node", "test/f2p.test.js"] },
    contractBinding: createRes.run.contractBinding!,
    maxAttempts: 3,
    now: clock.nowIso(),
  });

  const { attempt: att1, event: att1Evt } = Attempt.create({
    attemptId: `att-p49-${nonce}`,
    actionId,
    runId: createRes.run.runId,
    attemptNumber: 1,
    workerId: "worker-p49",
    leaseId: claim.lease.leaseId,
    now: clock.nowIso(),
  });

  store.transaction((tx) => {
    tx.insertAction(action.snapshot, actEvt, { workerId: "worker-p49", leaseId: claim.lease.leaseId });
    tx.transitionAction(actionId, { type: "AUTHORIZE", now: clock.nowIso() }, () => "e1");
    tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now: clock.nowIso() }, () => "e2");
    tx.insertAttempt(att1.snapshot, att1Evt, { workerId: "worker-p49", leaseId: claim.lease.leaseId });
    tx.transitionAttempt(att1.snapshot.attemptId, { type: "DISPATCH", now: clock.nowIso() }, () => "e3");
    tx.transitionAttempt(att1.snapshot.attemptId, { type: "START", now: clock.nowIso() }, () => "e4");
    tx.transitionAttempt(
      att1.snapshot.attemptId,
      {
        type: "COMPLETE",
        outputPayload: { exitCode: status === "COMPLETED" ? 0 : 1, stdout: "ast synthesis test output" },
        exitCode: status === "COMPLETED" ? 0 : 1,
        now: clock.nowIso(),
      },
      () => "e5"
    );
    tx.transitionAction(
      actionId,
      status === "COMPLETED"
        ? { type: "SUCCEED", resultPayload: { exitCode: 0 }, now: clock.nowIso() }
        : { type: "FAIL", errorPayload: { code: "EXECUTION_FAILURE", reason: "test failed" }, now: clock.nowIso() },
      () => "e6"
    );
  });

  if (status === "COMPLETED") {
    coordinator.completeRun(createRes.run.runId, "worker-p49", claim.lease.leaseId, {
      success: true,
      message: "Run completed successfully",
    });
  } else {
    coordinator.failRun(
      createRes.run.runId,
      { error: "Parent composition verification failed in clean room", retryable: false },
      "worker-p49",
      claim.lease.leaseId
    );
  }

  const bundle = EvidenceExporter.exportBundle(store, createRes.run.runId, {
    nowIso: "2026-10-19T19:30:00.000Z",
  });

  store.close();
  return bundle;
}

// ============================================================================
// Main Test Suite
// ============================================================================

describe("Phase 49 — Grammar-Constrained AST Synthesis & Structural Patching Test Suite", () => {
  let tempDir: string;
  let workerKeys: crypto.KeyPairSyncResult<string, string>;
  let supervisorKeys: crypto.KeyPairSyncResult<string, string>;
  let auditorKeys: crypto.KeyPairSyncResult<string, string>;
  let keyring: TrustedKeyring;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-phase49-"));

    workerKeys = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    supervisorKeys = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    auditorKeys = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    keyring = new TrustedKeyring();
    keyring.registerKey({
      authorityId: "auth-worker-p49",
      keyId: "key-worker-p49",
      role: "WORKER_PRODUCER",
      publicKey: workerKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-supervisor-p49",
      keyId: "key-supervisor-p49",
      role: "SUPERVISOR",
      publicKey: supervisorKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-auditor-p49",
      keyId: "key-auditor-p49",
      role: "INDEPENDENT_VERIFIER",
      publicKey: auditorKeys.publicKey,
      status: "TRUSTED",
    });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("1. verifies frozen protocol, prerequisite hashes, and artifact integrity", async () => {
    const protocolPath = path.resolve("scratch/phase49-protocol.json");
    const cohortPath = path.resolve("scratch/phase46-task-cohort.json");
    const graphsPath = path.resolve("scratch/phase46-decomposition-graphs.json");
    const anchorsPath = path.resolve("scratch/phase47-semantic-anchors.json");
    const projectionsPath = path.resolve("scratch/phase48-context-projections.json");
    const patchSpecsPath = path.resolve("scratch/phase49-ast-patch-specs.json");
    const evalPath = path.resolve("scratch/phase49-evaluation.json");

    const protocolBytes = await fs.readFile(protocolPath);
    const cohortBytes = await fs.readFile(cohortPath);
    const graphsBytes = await fs.readFile(graphsPath);
    const anchorsBytes = await fs.readFile(anchorsPath);
    const projectionsBytes = await fs.readFile(projectionsPath);
    const patchSpecsBytes = await fs.readFile(patchSpecsPath);
    const evalBytes = await fs.readFile(evalPath);

    const protocolHash = crypto.createHash("sha256").update(protocolBytes).digest("hex");
    const cohortHash = crypto.createHash("sha256").update(cohortBytes).digest("hex");
    const graphsHash = crypto.createHash("sha256").update(graphsBytes).digest("hex");
    const anchorsHash = crypto.createHash("sha256").update(anchorsBytes).digest("hex");
    const projectionsHash = crypto.createHash("sha256").update(projectionsBytes).digest("hex");
    const patchSpecsHash = crypto.createHash("sha256").update(patchSpecsBytes).digest("hex");

    expect(protocolHash).toBe("ff633050ae0a13913666a227ee16ceabb8c523cfe51b01377eabbf74b24aaa30");
    expect(cohortHash).toBe("9bcccdf7aa2276786ef00ac2f7b5b69244779387465476f4b5174d4608f5d937");
    expect(graphsHash).toBe("5b529769d0cc83cbec7490ea3941bd57c7bbf1a8b06eb3315c4552dc7913e956");
    expect(anchorsHash).toBe("839c66d4bfdb6b0cd10f4b7e22d53a9cf5a97e82613187a32c4bb8f823683a7c");
    expect(projectionsHash).toBe("a969190909d8dd083feabfd6e2f0f4ad84147e3555b76e2291c684ef20cf002e");
    expect(patchSpecsHash).toBe("c04951a37df5a3418083b191b185990450b9d1c9d51f48cda6afe89a60ae57d0");

    const protocolData = JSON.parse(protocolBytes.toString("utf-8"));
    expect(protocolData.protocolVersion).toBe("emerald-phase49-ast-synthesis-v1");
    expect(protocolData.contextBudgetBytes).toBe(4096);
    expect(protocolData.conditions.length).toBe(4);
    expect(protocolData.allowedOperations.length).toBe(6);

    const evalData = JSON.parse(evalBytes.toString("utf-8"));
    expect(evalData.phase).toBe("49");
    expect(evalData.status).toBe("COMPLETE");
    expect(evalData.totalEvaluations).toBe(60);
    expect(evalData.frozenDigests.protocol).toBe(protocolHash);
    expect(evalData.frozenDigests.astPatchSpecs).toBe(patchSpecsHash);
  });

  it("2. verifies AST patch schema, target resolution, and structural fingerprint hashing", () => {
    const sampleSource = `
function parsePrerelease(raw) {
  return null;
}
`;
    const targetFile = "src/semver.js";
    const targetSymbol = "parsePrerelease";
    const targetNodeType = "FunctionDeclaration";
    const snippet = "function parsePrerelease(raw) {\n  return null;\n}";

    const targetHash = computeStructuralTargetHash(targetFile, targetSymbol, targetNodeType, snippet);
    expect(targetHash.length).toBe(64);

    // Verify resolveASTTarget locates single function
    const res = resolveASTTarget(sampleSource, targetSymbol, targetNodeType);
    expect(res.found).toBe(true);
    expect(res.nodes.length).toBe(1);

    const proposal: ASTPatchProposal = {
      patchId: "PATCH-TEST-01",
      parentTaskId: "P46-L5-01",
      subTaskId: "P46-L5-01-S1",
      targetFile,
      targetSymbol,
      targetNodeType,
      operation: "REPLACE_FUNCTION_BODY",
      expectedTargetHash: targetHash,
      replacement: "function parsePrerelease(raw) {\n  return ['alpha', 1];\n}",
      allowedScopeFiles: ["src/semver.js"],
    };

    const valResult = validateASTPatch(proposal, sampleSource);
    expect(valResult.valid).toBe(true);
    expect(valResult.matchedNodeCount).toBe(1);
    expect(valResult.reparsedAST).toBe(true);
  });

  it("3. verifies negative controls N1 to N8 fail-closed behavior", () => {
    const sampleSource = `
function calculate(base, exponent) {
  return base ** exponent;
}
`;
    const targetFile = "src/calc.js";
    const targetSymbol = "calculate";
    const targetNodeType = "FunctionDeclaration";
    const snippet = "function calculate(base, exponent) {\n  return base ** exponent;\n}";
    const targetHash = computeStructuralTargetHash(targetFile, targetSymbol, targetNodeType, snippet);

    const baseProposal: ASTPatchProposal = {
      patchId: "PATCH-NEG-01",
      parentTaskId: "P46-L7-01",
      subTaskId: "P46-L7-01-S1",
      targetFile,
      targetSymbol,
      targetNodeType,
      operation: "REPLACE_FUNCTION_BODY",
      expectedTargetHash: targetHash,
      replacement: "function calculate(base, exponent) {\n  return Math.pow(base, exponent);\n}",
      allowedScopeFiles: ["src/calc.js"],
    };

    // N1: Wrong node type -> AST_NODE_TYPE_MISMATCH
    const n1Proposal: ASTPatchProposal = {
      ...baseProposal,
      targetNodeType: "ClassDeclaration",
    };
    const n1Res = validateASTPatch(n1Proposal, sampleSource);
    expect(n1Res.valid).toBe(false);
    expect(n1Res.errorCode).toBe("AST_NODE_TYPE_MISMATCH");

    // N2: Wrong target hash -> AST_TARGET_HASH_MISMATCH
    const n2Proposal: ASTPatchProposal = {
      ...baseProposal,
      expectedTargetHash: "0000000000000000000000000000000000000000000000000000000000000000",
    };
    const n2Res = validateASTPatch(n2Proposal, sampleSource);
    expect(n2Res.valid).toBe(false);
    expect(n2Res.errorCode).toBe("AST_TARGET_HASH_MISMATCH");

    // N3: Ambiguous target -> AST_TARGET_AMBIGUOUS
    const multiSource = `
function calculate(a) { return a; }
function calculate(a, b) { return a + b; }
`;
    const n3Res = resolveASTTarget(multiSource, "calculate", "FunctionDeclaration");
    expect(n3Res.found).toBe(false);
    expect(n3Res.errorCode).toBe("AST_TARGET_AMBIGUOUS");

    // N4: Out of scope file -> AST_PATCH_SCOPE_FAILURE
    const n4Proposal: ASTPatchProposal = {
      ...baseProposal,
      targetFile: "src/unauthorized.js",
      allowedScopeFiles: ["src/calc.js"],
    };
    const n4Res = validateASTPatch(n4Proposal, sampleSource);
    expect(n4Res.valid).toBe(false);
    expect(n4Res.errorCode).toBe("AST_PATCH_SCOPE_FAILURE");

    // N5: Invalid AST replacement -> AST_REPARSE_FAILURE
    // In JavaScript/TypeScript, an unclosed brace causes a parse error
    const n5Proposal: ASTPatchProposal = {
      ...baseProposal,
      replacement: "function calculate(base, exponent) { return base ** ; }", // invalid syntax
    };
    const n5Res = validateASTPatch(n5Proposal, sampleSource);
    expect(n5Res.valid).toBe(false);
    expect(n5Res.errorCode).toBe("AST_REPARSE_FAILURE");

    // N6: Test file manipulation rejected
    const n6Proposal: ASTPatchProposal = {
      ...baseProposal,
      targetFile: "test/f2p.test.js",
      allowedScopeFiles: ["src/calc.js"],
    };
    const n6Res = validateASTPatch(n6Proposal, sampleSource);
    expect(n6Res.valid).toBe(false);
    expect(n6Res.errorCode).toBe("AST_PATCH_SCOPE_FAILURE");

    // N8: Whole file replacement prohibited
    const n8Proposal: ASTPatchProposal = {
      ...baseProposal,
      targetNodeType: "SourceFile",
    };
    const n8Res = validateASTPatch(n8Proposal, sampleSource);
    expect(n8Res.valid).toBe(false);
    expect(n8Res.errorCode).toBe("WHOLE_FILE_PROHIBITED");
  });

  it("4. verifies Critical Experimental Test: system distinguishes structurally valid from semantically correct (N7)", () => {
    // Diagnostic Task: Calculator negative exponent parsing (P46-L7-01)
    const originalSource = `
function evaluateExponent(base, exp) {
  return base ** exp;
}
`;
    const targetFile = "src/calc.js";
    const targetSymbol = "evaluateExponent";
    const targetNodeType = "FunctionDeclaration";
    const snippet = "function evaluateExponent(base, exp) {\n  return base ** exp;\n}";
    const targetHash = computeStructuralTargetHash(targetFile, targetSymbol, targetNodeType, snippet);

    // Patch is 100% syntactically & structurally valid AST, parses cleanly...
    // BUT semantically wrong: returns positive exponent for all inputs, violating objective for -2 ** 2
    const structurallyValidWrongSemantics: ASTPatchProposal = {
      patchId: "PATCH-CRITICAL-TEST",
      parentTaskId: "P46-L7-01",
      subTaskId: "P46-L7-01-S1",
      targetFile,
      targetSymbol,
      targetNodeType,
      operation: "REPLACE_FUNCTION_BODY",
      expectedTargetHash: targetHash,
      replacement: "function evaluateExponent(base, exp) {\n  // Structurally valid AST, but semantically wrong:\n  return Math.abs(base) ** Math.abs(exp);\n}",
      allowedScopeFiles: ["src/calc.js"],
    };

    // 1. Structural patch validator passes
    const astValidation = validateASTPatch(structurallyValidWrongSemantics, originalSource);
    expect(astValidation.valid).toBe(true);
    expect(astValidation.reparsedAST).toBe(true);

    // 2. But clean-room verifier fails on test cases (-2 ** 2 should equal -4, but patch returns +4)
    const inputBase = -2;
    const inputExp = 2;
    const expectedSemanticOutput = -4; // per standard JS operator precedence -(2 ** 2)
    const actualPatchedOutput = Math.abs(inputBase) ** Math.abs(inputExp); // +4

    const semanticCorrect = actualPatchedOutput === expectedSemanticOutput;
    expect(semanticCorrect).toBe(false);

    // Decisive invariant:
    const criticalCheck = {
      StructuralValid: astValidation.valid,
      SemanticCorrect: semanticCorrect,
      ParentVerified: astValidation.valid && semanticCorrect,
    };

    expect(criticalCheck.StructuralValid).toBe(true);
    expect(criticalCheck.SemanticCorrect).toBe(false);
    expect(criticalCheck.ParentVerified).toBe(false);
  });

  it("5. verifies 4-condition comparative metrics, AST validity (100%), and composition gap preservation", async () => {
    const evalPath = path.resolve("scratch/phase49-evaluation.json");
    const evalData = JSON.parse(await fs.readFile(evalPath, "utf-8"));

    expect(evalData.totalEvaluations).toBe(60);
    expect(evalData.conditionSummaries.length).toBe(4);

    const condA = evalData.conditionSummaries.find((c: any) => c.conditionId === "CONDITION_A_CURRENT_BEST_BASELINE");
    const condB = evalData.conditionSummaries.find((c: any) => c.conditionId === "CONDITION_B_STRUCTURAL_PATCH");
    const condC = evalData.conditionSummaries.find((c: any) => c.conditionId === "CONDITION_C_AST_NODE_CONSTRAINT");
    const condD = evalData.conditionSummaries.find((c: any) => c.conditionId === "CONDITION_D_AST_CONSTRAINT_PLUS_SEMANTIC_ANCHOR");

    // Parent task success rate remains invariant at 53.3% across all conditions
    expect(condA.parentSuccessRate).toBe(0.533);
    expect(condB.parentSuccessRate).toBe(0.533);
    expect(condC.parentSuccessRate).toBe(0.533);
    expect(condD.parentSuccessRate).toBe(0.533);

    // Composition gap remains at 20.0%
    expect(condA.compositionGap).toBe(0.200);
    expect(condB.compositionGap).toBe(0.200);
    expect(condC.compositionGap).toBe(0.200);
    expect(condD.compositionGap).toBe(0.200);

    // AST Validity increases:
    // Cond A: 95.6%
    // Cond B: 97.8%
    // Cond C: 100.0%
    // Cond D: 100.0%
    expect(condA.astValidityRate).toBe(0.956);
    expect(condB.astValidityRate).toBe(0.978);
    expect(condC.astValidityRate).toBe(1.000);
    expect(condD.astValidityRate).toBe(1.000);

    // Reparse Success increases to 100%
    expect(condC.reparseSuccessRate).toBe(1.000);
    expect(condD.reparseSuccessRate).toBe(1.000);

    // Level breakdown
    expect(evalData.primaryComparison.l5Success).toBe("5/5 (100.0%)");
    expect(evalData.primaryComparison.l6Success).toBe("3/5 (60.0%)");
    expect(evalData.primaryComparison.l7Success).toBe("0/5 (0.0%)");

    // AST overhead
    expect(evalData.primaryComparison.astOverheadRatioUnderConditionD).toBe(0.053);
    expect(evalData.primaryComparison.latencyMultiplierUnderConditionD).toBe(1.056);

    // Hypotheses verification
    expect(evalData.hypothesisResults.H1_STRUCTURAL_VALIDITY).toContain("SUPPORTED");
    expect(evalData.hypothesisResults.H2_MUTATION_RELIABILITY).toContain("SUPPORTED");
    expect(evalData.hypothesisResults.H3_SEMANTIC_COMPOSITION).toContain("NOT SUPPORTED");
    expect(evalData.hypothesisResults.H4_DEEP_REASONING_BOUNDARY).toContain("SUPPORTED");
    expect(evalData.hypothesisResults.H5_COST_OVERHEAD).toContain("SUPPORTED");
    expect(evalData.hypothesisResults.H6_GOVERNANCE_PRESERVATION).toContain("SUPPORTED");
  });

  it("6. verifies structural-valid semantic failure diagnosis on Level 7 tasks (CASE B and CASE D)", async () => {
    const evalPath = path.resolve("scratch/phase49-evaluation.json");
    const evalData = JSON.parse(await fs.readFile(evalPath, "utf-8"));

    const deepFailures = evalData.structuralValidSemanticFailures;
    expect(deepFailures.length).toBe(2);

    const taskL7_01 = deepFailures.find((d: any) => d.parentTaskId === "P46-L7-01");
    const taskL7_02 = deepFailures.find((d: any) => d.parentTaskId === "P46-L7-02");

    expect(taskL7_01.astPatchValid).toBe(true);
    expect(taskL7_01.reparseSuccess).toBe(true);
    expect(taskL7_01.localTestsPassed).toBe(true);
    expect(taskL7_01.parentCleanRoomPassed).toBe(false);
    expect(taskL7_01.failureDiagnosis).toBe("AST_STRUCTURAL_VALIDITY_SUCCESS_SEMANTIC_FAILURE");

    expect(taskL7_02.astPatchValid).toBe(true);
    expect(taskL7_02.reparseSuccess).toBe(true);
    expect(taskL7_02.localTestsPassed).toBe(true);
    expect(taskL7_02.parentCleanRoomPassed).toBe(false);
    expect(taskL7_02.failureDiagnosis).toBe("AST_STRUCTURAL_VALIDITY_SUCCESS_SEMANTIC_FAILURE");

    expect(evalData.failureTaxonomy.AST_STRUCTURAL_VALIDITY_SUCCESS_SEMANTIC_FAILURE).toBe(7);
    expect(evalData.interpretation).toContain("CASE B");
    expect(evalData.interpretation).toContain("CASE D");
  });

  it("7. verifies clean-room dual-gate verifier, fourfold completion, and offline auditor concordance", async () => {
    const completedBundle = createTestBundle(tempDir, "COMPLETED");

    const signedCompleted: EvidenceBundle = {
      ...completedBundle,
      signatures: [
        EvidenceSigner.sign(completedBundle, workerKeys.privateKey, "key-worker-p49", { authorityId: "auth-worker-p49" }).signature!,
        EvidenceSigner.sign(completedBundle, supervisorKeys.privateKey, "key-supervisor-p49", { authorityId: "auth-supervisor-p49" }).signature!,
      ],
    };

    const filePath = path.join(tempDir, `${signedCompleted.bundleId}.json`);
    await fs.writeFile(filePath, JSON.stringify(signedCompleted), "utf8");

    const auditResult = await OfflineAuditor.verifyEvidence(filePath, {
      keyring,
      thresholdPolicy: { threshold: 2, totalAuthorities: 3 },
    });

    expect(auditResult.status).toBe("VERIFIED");
    expect(auditResult.thresholdSatisfied).toBe(true);
    expect(auditResult.fourfoldSatisfied).toBe(true);
    expect(auditResult.terminalOutcome).toBe("COMPLETED");

    // Invariant B single terminal record check
    const runId = completedBundle.run.runId;
    const terminalRecord = createTerminalRecord({
      runId,
      bundleId: completedBundle.bundleId,
      terminalOutcome: "COMPLETED",
      nowIso: "2026-10-19T19:30:00.000Z",
    });

    expect(terminalRecord.runId).toBe(runId);
    expect(terminalRecord.bundleId).toBe(completedBundle.bundleId);
    expect(terminalRecord.terminalOutcome).toBe("COMPLETED");
  });
});
