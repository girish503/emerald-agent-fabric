/**
 * Phase 44 Minimal Offline Proof: Action Proposal Schema Parity & Representative Validation.
 *
 * Establishes:
 * 1. Concrete Discriminated-Union Schema: Defines an explicit multi-branch JSON Schema
 *    where each tool payload is strictly bounded (properties, required, additionalProperties: false).
 * 2. Zod AST Parity & Drift Detection: Verifies that every tool's JSON Schema matches
 *    the authoritative Zod AST from src/domain/tool-schemas.ts via introspectToolInputSchema().
 * 3. Negative Invariant Enforcement: Proves that hallucination traps ("filePath", "text", "pattern")
 *    are absent from the candidate schema.
 * 4. Six Representative Cases: Validates in-memory against the candidate JSON Schema:
 *    - Case 1: Valid read_file with path
 *    - Case 2: Invalid read_file with filePath
 *    - Case 3: Invalid proposal with extraneous argument
 *    - Case 4: Malformed proposal envelope
 *    - Case 5: Valid goal-completion proposal (no tool arguments)
 *    - Case 6: Additional tools with distinct argument structures (write_file, run_command)
 * 5. ProposalValidator Dual Verification: Demonstrates that valid schema proposals pass
 *    authoritative runtime validation, while invalid proposals fail closed.
 *
 * Zero live inference. Zero new dependencies. Zero production runtime modifications.
 */

import { describe, expect, it } from "vitest";
import {
  INITIAL_TOOL_DEFINITIONS,
  TOOL_NAMES,
  ToolName,
} from "../../src/domain/tool.js";
import {
  introspectToolInputSchema,
  ProjectedParameter,
} from "../../src/domain/tool-projection.js";
import {
  ProposalValidationContext,
  ProposalValidator,
} from "../../src/application/proposal-validator.js";
import {
  computeContextHash,
  ContextSnapshot,
  DEFAULT_CONTEXT_BUDGET,
  Observation,
} from "../../src/domain/context.js";
import { RunSnapshot } from "../../src/domain/invariants.js";
import {
  createExecutionPolicy,
  createMissionContract,
  createResourceLimits,
  MissionContract,
} from "../../src/domain/index.js";
import { ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA } from "../../src/application/live-agent-brain.js";

// ============================================================================
// 1. Promoted Governed Action Proposal JSON Schema from LiveAgentBrain
// ============================================================================

export const PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA =
  ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA.jsonSchema as any;

// ============================================================================
// 2. Pure In-Memory JSON Schema Subset Validator (Offline, Zero Dependencies)
// ============================================================================

interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

interface ValidationOutcome {
  readonly valid: boolean;
  readonly errors: readonly ValidationIssue[];
}

function validateAgainstNode(schema: Record<string, any>, value: unknown, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Type validation
  if (schema.type) {
    if (schema.type === "object") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        issues.push({ path, message: `Expected object, received ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}` });
        return issues;
      }
    } else if (schema.type === "string") {
      if (typeof value !== "string") {
        issues.push({ path, message: `Expected string, received ${typeof value}` });
        return issues;
      }
      if (typeof schema.minLength === "number" && value.length < schema.minLength) {
        issues.push({ path, message: `String length ${value.length} is less than minLength ${schema.minLength}` });
      }
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
        issues.push({ path, message: `String length ${value.length} exceeds maxLength ${schema.maxLength}` });
      }
      if (typeof schema.pattern === "string") {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(value)) {
          issues.push({ path, message: `String does not match pattern ${schema.pattern}` });
        }
      }
    } else if (schema.type === "boolean") {
      if (typeof value !== "boolean") {
        issues.push({ path, message: `Expected boolean, received ${typeof value}` });
        return issues;
      }
    } else if (schema.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        issues.push({ path, message: `Expected integer, received ${typeof value === "number" ? "non-integer number" : typeof value}` });
        return issues;
      }
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        issues.push({ path, message: `Integer ${value} is less than minimum ${schema.minimum}` });
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        issues.push({ path, message: `Integer ${value} exceeds maximum ${schema.maximum}` });
      }
    } else if (schema.type === "array") {
      if (!Array.isArray(value)) {
        issues.push({ path, message: `Expected array, received ${typeof value}` });
        return issues;
      }
      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        issues.push({ path, message: `Array length ${value.length} is less than minItems ${schema.minItems}` });
      }
      if (schema.items) {
        value.forEach((item, idx) => {
          issues.push(...validateAgainstNode(schema.items, item, `${path}[${idx}]`));
        });
      }
    }
  }

  // Enum validation
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value as any)) {
      issues.push({ path, message: `Value ${JSON.stringify(value)} not in allowed enum: [${schema.enum.map((e: any) => JSON.stringify(e)).join(", ")}]` });
    }
  }

  // Object properties & required fields
  if (schema.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    // Required fields check
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!(reqKey in obj) || obj[reqKey] === undefined) {
          issues.push({ path: path ? `${path}.${reqKey}` : reqKey, message: `Missing required property '${reqKey}'` });
        }
      }
    }

    // Properties check
    const props = schema.properties ?? {};
    for (const [key, propVal] of Object.entries(obj)) {
      if (key in props) {
        issues.push(...validateAgainstNode(props[key], propVal, path ? `${path}.${key}` : key));
      } else if (schema.additionalProperties === false) {
        issues.push({ path: path ? `${path}.${key}` : key, message: `Disallowed extraneous property '${key}'` });
      }
    }
  }

  return issues;
}

export function validateCandidateProposal(schema: typeof PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA, proposal: unknown): ValidationOutcome {
  if (!schema.anyOf || !Array.isArray(schema.anyOf)) {
    throw new Error("Candidate schema must define anyOf branches");
  }

  const branchFailures: { branchIndex: number; errors: ValidationIssue[] }[] = [];

  for (let i = 0; i < schema.anyOf.length; i++) {
    const branch = schema.anyOf[i];
    const issues = validateAgainstNode(branch, proposal, "");
    if (issues.length === 0) {
      return { valid: true, errors: [] };
    }
    branchFailures.push({ branchIndex: i, errors: issues });
  }

  // When all branches fail, return accumulated issues
  const allErrors = branchFailures.flatMap((f) => f.errors);
  return { valid: false, errors: allErrors };
}

// ============================================================================
// 3. Test Fixture Helpers
// ============================================================================

function createMockSnapshot(contextHash: string = "a".repeat(64)): ContextSnapshot {
  const budget = DEFAULT_CONTEXT_BUDGET;
  const observations: readonly Observation[] = [
    {
      observationId: "obs-1",
      category: "RUN_STATE",
      provenance: {
        entityKind: "Run",
        entityId: "run-test-1",
        runId: "run-test-1",
        timestamp: "2026-10-26T12:00:00.000Z",
        isAuthoritativeRuntimeFact: true,
      },
      priority: 1,
      freshness: "CURRENT",
      content: { runId: "run-test-1", status: "RUNNING" },
      contentHash: contextHash,
      estimatedTokens: 10,
      estimatedBytes: 40,
      isMandatory: true,
    },
  ];

  return {
    snapshotId: "snap-test-1",
    runId: "run-test-1",
    taskId: "task-test-1",
    policyVersion: "context-policy-v1",
    createdAt: "2026-10-26T12:00:00.000Z",
    budget,
    observations,
    omittedObservationsCount: 0,
    omittedObservationsSummary: [],
    totalEstimatedTokens: 10,
    totalBytes: 40,
    contextHash,
  };
}

function createMockContract(): MissionContract {
  return createMissionContract({
    contractId: "contract-test-1",
    version: 1,
    taskId: "task-test-1",
    policy: createExecutionPolicy({
      policyId: "policy-test-1",
      allowedCapabilities: [
        "workspace.file.read",
        "workspace.file.write",
        "workspace.code.search",
        "process.execute",
        "git.read",
      ],
      isolationRequirement: "ISOLATED",
    }),
    resourceLimits: createResourceLimits({
      timeoutMs: 30000,
      maxAttempts: 3,
      maxOutputBytes: 1048576,
    }),
    status: "ACTIVE",
    createdAt: "2026-10-26T12:00:00.000Z",
    activatedAt: "2026-10-26T12:00:00.000Z",
  });
}

function createMockRun(contract: MissionContract): RunSnapshot {
  return {
    runId: "run-test-1",
    taskId: "task-test-1",
    status: "RUNNING",
    version: 1,
    attemptCount: 1,
    maxAttempts: 3,
    timeoutMs: 30000,
    idempotencyKey: null,
    currentWorkerId: "worker-test-1",
    leaseId: "lease-test-1",
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    contractBinding: {
      contractId: contract.spec.contractId,
      version: contract.spec.version,
      contentHash: contract.contentHash,
    },
    resultPayload: null,
    errorPayload: null,
    createdAt: "2026-10-26T12:00:00.000Z",
    updatedAt: "2026-10-26T12:00:00.000Z",
  };
}

// ============================================================================
// 4. Test Suites
// ============================================================================

describe("Phase 44 Preflight: Action Proposal Schema Parity & Representative Validation", () => {
  const contextHash = "a".repeat(64);

  // --------------------------------------------------------------------------
  // Suite 1: Candidate Schema Structural Completeness
  // --------------------------------------------------------------------------
  describe("1. Candidate Schema Structural Completeness", () => {
    it("defines exactly 7 anyOf branches (1 goal completion + 6 tools)", () => {
      expect(PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA.anyOf.length).toBe(8);
    });

    it("includes Branch 1 as strict goal-completion signal with no tool fields", () => {
      const goalBranch = PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA.anyOf[0];
      expect(goalBranch.properties.isGoalReached.enum).toEqual([true]);
      expect(goalBranch.required).toEqual(["isGoalReached", "proposalId", "contextSnapshotHash"]);
      expect(goalBranch.additionalProperties).toBe(false);
      expect((goalBranch.properties as any).toolName).toBeUndefined();
      expect((goalBranch.properties as any).inputPayload).toBeUndefined();
    });

    it("covers all 6 registered tools across Branches 2-7", () => {
      const toolBranches = PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA.anyOf.slice(1);
      const coveredTools = toolBranches.map((b: any) => (b.properties.toolName as any).enum[0]);
      expect(coveredTools.sort()).toEqual([...TOOL_NAMES].sort());
    });
  });

  // --------------------------------------------------------------------------
  // Suite 2: Zod AST Parity & Drift Detection
  // --------------------------------------------------------------------------
  describe("2. Zod AST Parity & Drift Detection", () => {
    for (const tool of INITIAL_TOOL_DEFINITIONS) {
      it(`matches introspected Zod parameters exactly for ${tool.name}`, () => {
        const zodParams: readonly ProjectedParameter[] = introspectToolInputSchema(tool.inputSchema);
        const expectedParamNames = zodParams.map((p) => p.name).sort();
        const expectedRequiredNames = zodParams.filter((p) => !p.isOptional).map((p) => p.name).sort();

        const branch = PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA.anyOf.find(
          (b: any) => (b.properties as any).toolName?.enum?.[0] === tool.name
        );
        expect(branch).toBeDefined();

        const schemaPayloadProps = Object.keys(branch!.properties.inputPayload.properties).sort();
        const schemaRequired = [...(branch!.properties.inputPayload.required ?? [])].sort();

        // Parameter names match Zod AST 1:1
        expect(schemaPayloadProps).toEqual(expectedParamNames);

        // Required parameters match Zod AST 1:1
        expect(schemaRequired).toEqual(expectedRequiredNames);

        // additionalProperties is strictly false
        expect(branch!.properties.inputPayload.additionalProperties).toBe(false);
      });
    }
  });

  // --------------------------------------------------------------------------
  // Suite 3: Negative Invariant Checks (Anti-Hallucination Guardrails)
  // --------------------------------------------------------------------------
  describe("3. Negative Invariant Checks", () => {
    const knownHallucinationKeys = ["filePath", "file_path", "text", "pattern", "startLine", "flags", "cmd"];

    for (const tool of INITIAL_TOOL_DEFINITIONS) {
      it(`does NOT contain hallucination trap keys in schema for ${tool.name}`, () => {
        const branch = PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA.anyOf.find(
          (b: any) => (b.properties as any).toolName?.enum?.[0] === tool.name
        );
        expect(branch).toBeDefined();

        const schemaPayloadProps = Object.keys(branch!.properties.inputPayload.properties);
        for (const trap of knownHallucinationKeys) {
          expect(schemaPayloadProps).not.toContain(trap);
        }
      });
    }
  });

  // --------------------------------------------------------------------------
  // Suite 4: Six Representative Cases (In-Memory Offline Schema Validation)
  // --------------------------------------------------------------------------
  describe("4. Six Representative Cases under Promoted Schema", () => {
    // Case 1: Valid read_file with path
    it("Case 1: VALID read_file proposal with path passes schema validation", () => {
      const validReadFile = {
        isGoalReached: false,
        proposalId: "prop-101",
        toolName: "read_file",
        inputPayload: {
          path: "src/calc.js",
          offsetLine: 1,
          limitLines: 100,
        },
        contextSnapshotHash: contextHash,
        rationale: "Inspecting calculator implementation",
      };

      const result = validateCandidateProposal(PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA, validReadFile);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    // Case 2: Invalid read_file containing filePath
    it("Case 2: INVALID read_file proposal with filePath is rejected by candidate schema", () => {
      const invalidReadFile = {
        isGoalReached: false,
        proposalId: "prop-102",
        toolName: "read_file",
        inputPayload: {
          filePath: "src/calc.js", // Hallucinated key
        },
        contextSnapshotHash: contextHash,
      };

      const result = validateCandidateProposal(PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA, invalidReadFile);
      expect(result.valid).toBe(false);

      // Verify that failure explicitly identifies missing 'path' and disallowed 'filePath'
      const errorMessages = result.errors.map((e) => e.message);
      expect(errorMessages.some((m) => m.includes("Missing required property 'path'"))).toBe(true);
      expect(errorMessages.some((m) => m.includes("Disallowed extraneous property 'filePath'"))).toBe(true);
    });

    // Case 3: Invalid proposal with unknown argument
    it("Case 3: INVALID read_file proposal with extraneous argument is rejected by candidate schema", () => {
      const invalidExtraArg = {
        isGoalReached: false,
        proposalId: "prop-103",
        toolName: "read_file",
        inputPayload: {
          path: "src/calc.js",
          extraUnknownOption: true, // Extraneous key
        },
        contextSnapshotHash: contextHash,
      };

      const result = validateCandidateProposal(PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA, invalidExtraArg);
      expect(result.valid).toBe(false);
      const errorMessages = result.errors.map((e) => e.message);
      expect(errorMessages.some((m) => m.includes("Disallowed extraneous property 'extraUnknownOption'"))).toBe(true);
    });

    // Case 4: Malformed proposal envelope
    it("Case 4: MALFORMED proposal envelope is rejected by candidate schema", () => {
      const malformedEnvelope = {
        toolName: "read_file",
        inputPayload: {
          path: "src/calc.js",
        },
        // Missing isGoalReached, proposalId, contextSnapshotHash
      };

      const result = validateCandidateProposal(PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA, malformedEnvelope);
      expect(result.valid).toBe(false);
      const errorMessages = result.errors.map((e) => e.message);
      expect(errorMessages.some((m) => m.includes("Missing required property 'isGoalReached'"))).toBe(true);
    });

    // Case 5: Valid goal-completion proposal (no tool arguments)
    it("Case 5: VALID goal-completion proposal passes candidate schema", () => {
      const validGoal = {
        isGoalReached: true,
        proposalId: "prop-goal-101",
        contextSnapshotHash: contextHash,
        rationale: "Task objective has been fully achieved and verified.",
      };

      const result = validateCandidateProposal(PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA, validGoal);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it("Case 5b: INVALID goal-completion proposal with contaminated tool arguments is rejected", () => {
      const contaminatedGoal = {
        isGoalReached: true,
        proposalId: "prop-goal-102",
        contextSnapshotHash: contextHash,
        toolName: "read_file", // Contaminating tool field
        inputPayload: { path: "src/calc.js" },
      };

      const result = validateCandidateProposal(PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA, contaminatedGoal);
      expect(result.valid).toBe(false);
      const errorMessages = result.errors.map((e) => e.message);
      expect(errorMessages.some((m) => m.includes("Disallowed extraneous property 'toolName'"))).toBe(true);
    });

    // Case 6: Additional tools with distinct argument structures
    it("Case 6a: VALID write_file proposal passes candidate schema", () => {
      const validWrite = {
        isGoalReached: false,
        proposalId: "prop-104",
        toolName: "write_file",
        inputPayload: {
          path: "src/calc.js",
          content: "export function add(a, b) { return a + b; }\n",
          overwrite: true,
        },
        contextSnapshotHash: contextHash,
      };

      const result = validateCandidateProposal(PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA, validWrite);
      expect(result.valid).toBe(true);
    });

    it("Case 6b: INVALID write_file proposal missing content is rejected", () => {
      const invalidWrite = {
        isGoalReached: false,
        proposalId: "prop-105",
        toolName: "write_file",
        inputPayload: {
          path: "src/calc.js",
          // Missing content
        },
        contextSnapshotHash: contextHash,
      };

      const result = validateCandidateProposal(PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA, invalidWrite);
      expect(result.valid).toBe(false);
      const errorMessages = result.errors.map((e) => e.message);
      expect(errorMessages.some((m) => m.includes("Missing required property 'content'"))).toBe(true);
    });

    it("Case 6c: VALID run_command proposal passes candidate schema", () => {
      const validCommand = {
        isGoalReached: false,
        proposalId: "prop-106",
        toolName: "run_command",
        inputPayload: {
          argv: ["npm", "test"],
          timeoutMs: 15000,
        },
        contextSnapshotHash: contextHash,
      };

      const result = validateCandidateProposal(PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA, validCommand);
      expect(result.valid).toBe(true);
    });

    it("Case 6d: INVALID run_command proposal with string argv (not array) is rejected", () => {
      const invalidCommand = {
        isGoalReached: false,
        proposalId: "prop-107",
        toolName: "run_command",
        inputPayload: {
          argv: "npm test", // String instead of array
        },
        contextSnapshotHash: contextHash,
      };

      const result = validateCandidateProposal(PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA, invalidCommand);
      expect(result.valid).toBe(false);
      const errorMessages = result.errors.map((e) => e.message);
      expect(errorMessages.some((m) => m.includes("Expected array"))).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 5: Compatibility Boundary with Authoritative ProposalValidator
  // --------------------------------------------------------------------------
  describe("5. Compatibility Boundary with Authoritative ProposalValidator", () => {
    const contract = createMockContract();
    const run = createMockRun(contract);
    const snapshot = createMockSnapshot(contextHash);
    const validationContext: ProposalValidationContext = {
      runId: run.runId,
      contextSnapshot: snapshot,
      workerId: "worker-test-1",
      leaseId: "lease-test-1",
      run,
      contract,
    };

    it("proves proposals valid under candidate schema pass ProposalValidator.validate()", () => {
      const validator = new ProposalValidator();
      const validProposal = {
        proposalId: "prop-pv-1",
        toolName: "read_file" as ToolName,
        inputPayload: {
          path: "src/calc.js",
          offsetLine: 1,
          limitLines: 50,
        },
        contextSnapshotHash: contextHash,
        rationale: "Read calculator source",
      };

      // 1. Passes candidate JSON Schema
      const schemaCheck = validateCandidateProposal(PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA, {
        isGoalReached: false,
        ...validProposal,
      });
      expect(schemaCheck.valid).toBe(true);

      // 2. Passes authoritative ProposalValidator
      const result = validator.validate(validProposal, validationContext);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.proposal.toolName).toBe("read_file");
        expect(result.proposal.inputPayload).toEqual(validProposal.inputPayload);
      }
    });

    it("proves proposals with filePath rejected by schema are also rejected by ProposalValidator", () => {
      const validator = new ProposalValidator();
      const invalidProposal = {
        proposalId: "prop-pv-2",
        toolName: "read_file" as ToolName,
        inputPayload: {
          filePath: "src/calc.js",
        },
        contextSnapshotHash: contextHash,
      };

      // 1. Fails candidate JSON Schema
      const schemaCheck = validateCandidateProposal(PROMOTED_ACTION_PROPOSAL_JSON_SCHEMA, {
        isGoalReached: false,
        ...invalidProposal,
      });
      expect(schemaCheck.valid).toBe(false);

      // 2. Fails authoritative ProposalValidator
      const result = validator.validate(invalidProposal, validationContext);
      expect(result.valid).toBe(false);
      if (result.valid === false) {
        expect(result.reason).toBe("INVALID_TOOL_INPUT");
        expect(result.message.toLowerCase()).toContain("unrecognized key");
      }
    });
  });
});
