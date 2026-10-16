/**
 * Tests for Standardized Model-Facing Tool Projection (ADR-0029 / Phase 10I).
 *
 * Verifies:
 * 1. Projection Determinism: Identical output across repeated calls.
 * 2. Six-Tool Coverage: All registered tools in INITIAL_TOOL_DEFINITIONS are projected.
 * 3. Runtime Schema Parity & Drift Detection: Parameters match Zod AST directly.
 * 4. Minimal Example Validation: Prompt examples pass runtime Zod schemas.
 * 5. Negative Authority & Security: Zero capability/authority/sandbox leaks.
 * 6. Size Budget Compliance: Average bytes per tool <= 250 bytes.
 * 7. LiveAgentBrain Integration: Requests include standardized tool catalog.
 * 8. ProposalValidator Strictness: Runtime strictly rejects invented fields.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LiveAgentBrain } from "../../src/application/live-agent-brain.js";
import { ProposalValidationContext, ProposalValidator } from "../../src/application/proposal-validator.js";
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
import { ModelProviderPort } from "../../src/ports/model-provider.port.js";
import { ModelProviderRequest, ModelProviderResponse } from "../../src/domain/model-provider.js";
import {
  INITIAL_TOOL_DEFINITIONS,
  READ_FILE_TOOL,
  RUN_COMMAND_TOOL,
  SEARCH_CODE_TOOL,
  staticToolRegistry,
  TOOL_NAMES,
  ToolName,
} from "../../src/domain/tool.js";
import {
  formatModelFacingToolCatalog,
  inspectToolProjection,
  introspectToolInputSchema,
  projectToolDefinition,
  TOOL_SEMANTIC_METADATA,
} from "../../src/domain/tool-projection.js";

// ============================================================================
// Helpers & Doubles
// ============================================================================

class StubModelProvider implements ModelProviderPort {
  readonly providerName = "stub-provider";
  readonly calls: ModelProviderRequest[] = [];

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.calls.push(request);
    return {
      requestId: request.requestId,
      model: request.model,
      outputText: JSON.stringify({
        isGoalReached: true,
        proposalId: "prop-1",
        rationale: "Goal reached",
        contextSnapshotHash: "hash-1",
      }),
      finishReason: "STOP",
      durationMs: 10,
    };
  }
}

function createMockSnapshot(): ContextSnapshot {
  const budget = DEFAULT_CONTEXT_BUDGET;
  const observations: readonly Observation[] = [
    {
      observationId: "obs-1",
      category: "RUN_STATE",
      provenance: {
        entityKind: "Run",
        entityId: "run-test-1",
        runId: "run-test-1",
        timestamp: "2026-10-16T12:00:00.000Z",
        isAuthoritativeRuntimeFact: true,
      },
      priority: 1,
      freshness: "CURRENT",
      content: { runId: "run-test-1", status: "RUNNING" },
      contentHash: "a".repeat(64),
      estimatedTokens: 10,
      estimatedBytes: 40,
      isMandatory: true,
    },
  ];

  const contextHash = computeContextHash({
    runId: "run-test-1",
    taskId: "task-test-1",
    policyVersion: "context-policy-v1",
    budget,
    observations,
  });

  return {
    snapshotId: "snap-test-1",
    runId: "run-test-1",
    taskId: "task-test-1",
    policyVersion: "context-policy-v1",
    createdAt: "2026-10-16T12:00:00.000Z",
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
    createdAt: "2026-10-16T12:00:00.000Z",
    activatedAt: "2026-10-16T12:00:00.000Z",
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
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    resultPayload: null,
    errorPayload: null,
    contractBinding: {
      contractId: contract.spec.contractId,
      version: contract.spec.version,
      contentHash: contract.contentHash,
    },
    createdAt: "2026-10-16T12:00:00.000Z",
    updatedAt: "2026-10-16T12:00:00.000Z",
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Standardized Model-Facing Tool Projection (ADR-0029 / Phase 10I)", () => {
  // --------------------------------------------------------------------------
  // 1. Determinism
  // --------------------------------------------------------------------------
  describe("1. Determinism", () => {
    it("produces byte-identical output across 100 repeated invocations", () => {
      const firstRun = formatModelFacingToolCatalog(INITIAL_TOOL_DEFINITIONS);
      for (let i = 0; i < 100; i++) {
        const nextRun = formatModelFacingToolCatalog(INITIAL_TOOL_DEFINITIONS);
        expect(nextRun).toBe(firstRun);
      }
    });

    it("produces deterministic SHA-256 projection hashes per tool", () => {
      for (const tool of INITIAL_TOOL_DEFINITIONS) {
        const inspection1 = inspectToolProjection(tool);
        const inspection2 = inspectToolProjection(tool);
        expect(inspection1.sha256).toBe(inspection2.sha256);
        expect(inspection1.formattedProjection).toBe(inspection2.formattedProjection);
        expect(inspection1.byteLength).toBe(inspection2.byteLength);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. Six-Tool Coverage
  // --------------------------------------------------------------------------
  describe("2. Six-Tool Coverage", () => {
    it("covers exactly all six INITIAL_TOOL_DEFINITIONS", () => {
      expect(INITIAL_TOOL_DEFINITIONS.length).toBe(6);
      const toolNames = INITIAL_TOOL_DEFINITIONS.map((t) => t.name);
      expect(toolNames.sort()).toEqual([...TOOL_NAMES].sort());
    });

    it("has metadata declared for all six tools in TOOL_SEMANTIC_METADATA", () => {
      for (const name of TOOL_NAMES) {
        const meta = TOOL_SEMANTIC_METADATA[name];
        expect(meta).toBeDefined();
        expect(meta.summary.length).toBeGreaterThan(10);
        expect(Object.keys(meta.minimalExample).length).toBeGreaterThan(0);
        expect(meta.invalidFieldWarning.length).toBeGreaterThan(10);
      }
    });

    it("formats every tool in catalog output", () => {
      const catalog = formatModelFacingToolCatalog(INITIAL_TOOL_DEFINITIONS);
      for (const name of TOOL_NAMES) {
        expect(catalog).toContain(`- ${name}(`);
      }
    });

    it("returns 'No tools available.' for empty tool array", () => {
      expect(formatModelFacingToolCatalog([])).toBe("No tools available.");
    });
  });

  // --------------------------------------------------------------------------
  // 3. Runtime Schema Parity & Drift Detection
  // --------------------------------------------------------------------------
  describe("3. Runtime Schema Parity & Drift Detection", () => {
    for (const tool of INITIAL_TOOL_DEFINITIONS) {
      it(`introspects parameter keys matching runtime Zod schema for ${tool.name}`, () => {
        let rawSchema: z.ZodTypeAny = tool.inputSchema;
        while (rawSchema instanceof z.ZodEffects) {
          rawSchema = rawSchema.innerType();
        }
        const shape = (rawSchema as z.ZodObject<any>).shape;
        const expectedKeys = Object.keys(shape);

        const params = introspectToolInputSchema(tool.inputSchema);
        const introspectedKeys = params.map((p) => p.name);

        expect(introspectedKeys).toEqual(expectedKeys);
      });
    }

    it("accurately identifies required vs optional parameters", () => {
      const readParams = introspectToolInputSchema(READ_FILE_TOOL.inputSchema);
      const pathParam = readParams.find((p) => p.name === "path");
      const offsetParam = readParams.find((p) => p.name === "offsetLine");
      const limitParam = readParams.find((p) => p.name === "limitLines");
      const maxBytesParam = readParams.find((p) => p.name === "maxBytes");

      expect(pathParam?.isOptional).toBe(false);
      expect(offsetParam?.isOptional).toBe(true);
      expect(offsetParam?.defaultValue).toBe(1);
      expect(limitParam?.isOptional).toBe(true);
      expect(limitParam?.defaultValue).toBe(500);
      expect(maxBytesParam?.isOptional).toBe(true);

      const searchParams = introspectToolInputSchema(SEARCH_CODE_TOOL.inputSchema);
      const queryParam = searchParams.find((p) => p.name === "query");
      const isRegexParam = searchParams.find((p) => p.name === "isRegex");
      const pathDirParam = searchParams.find((p) => p.name === "path");

      expect(queryParam?.isOptional).toBe(false);
      expect(isRegexParam?.isOptional).toBe(true);
      expect(isRegexParam?.defaultValue).toBe(false);
      expect(pathDirParam?.isOptional).toBe(true);
      expect(pathDirParam?.defaultValue).toBe(".");

      const runParams = introspectToolInputSchema(RUN_COMMAND_TOOL.inputSchema);
      const argvParam = runParams.find((p) => p.name === "argv");
      expect(argvParam?.isOptional).toBe(false);
      expect(argvParam?.type).toBe("string[]");
    });
  });

  // --------------------------------------------------------------------------
  // 4. Minimal Example Validation against Authoritative Zod Schemas
  // --------------------------------------------------------------------------
  describe("4. Minimal Example Validation against Authoritative Zod Schemas", () => {
    for (const tool of INITIAL_TOOL_DEFINITIONS) {
      it(`validates that minimalExample for ${tool.name} passes runtime Zod safeParse`, () => {
        const meta = TOOL_SEMANTIC_METADATA[tool.name as ToolName];
        expect(meta).toBeDefined();

        const parseResult = tool.inputSchema.safeParse(meta.minimalExample);
        expect(
          parseResult.success,
          `minimalExample for ${tool.name} failed runtime validation: ${
            parseResult.success ? "" : JSON.stringify(parseResult.error.format())
          }`
        ).toBe(true);
      });

      it(`validates that every key in minimalExample for ${tool.name} exists in inputSchema`, () => {
        const meta = TOOL_SEMANTIC_METADATA[tool.name as ToolName];
        let rawSchema: z.ZodTypeAny = tool.inputSchema;
        while (rawSchema instanceof z.ZodEffects) {
          rawSchema = rawSchema.innerType();
        }
        const schemaKeys = new Set(Object.keys((rawSchema as z.ZodObject<any>).shape));

        for (const exampleKey of Object.keys(meta.minimalExample)) {
          expect(
            schemaKeys.has(exampleKey),
            `minimalExample for ${tool.name} contains unknown field "${exampleKey}"`
          ).toBe(true);
        }
      });
    }
  });

  // --------------------------------------------------------------------------
  // 5. Negative Authority & Security Leakage
  // --------------------------------------------------------------------------
  describe("5. Negative Authority & Security Leakage", () => {
    const FORBIDDEN_STRINGS = [
      "workspace.file.read",
      "workspace.file.write",
      "workspace.code.search",
      "git.read",
      "process.execute",
      "capability",
      "idempotency",
      "IDEMPOTENT",
      "NON_IDEMPOTENT",
      "workerId",
      "leaseId",
      "contractId",
      "containerMountPath",
      "mountPath",
      "SANDBOX",
      "WORKSPACE",
    ];

    it("ensures catalog projection contains zero internal authority or capability strings", () => {
      const catalog = formatModelFacingToolCatalog(INITIAL_TOOL_DEFINITIONS);
      for (const forbidden of FORBIDDEN_STRINGS) {
        expect(catalog).not.toContain(forbidden);
      }
    });

    for (const tool of INITIAL_TOOL_DEFINITIONS) {
      it(`ensures tool projection for ${tool.name} contains zero authority leaks`, () => {
        const projected = projectToolDefinition(tool);
        for (const forbidden of FORBIDDEN_STRINGS) {
          expect(projected).not.toContain(forbidden);
        }
      });
    }
  });

  // --------------------------------------------------------------------------
  // 6. Size Budget Compliance
  // --------------------------------------------------------------------------
  describe("6. Size Budget Compliance", () => {
    it("ensures average description size per tool is <= 250 bytes", () => {
      let totalBytes = 0;
      for (const tool of INITIAL_TOOL_DEFINITIONS) {
        const inspection = inspectToolProjection(tool);
        totalBytes += inspection.byteLength;
      }

      const avgBytes = totalBytes / INITIAL_TOOL_DEFINITIONS.length;
      expect(avgBytes).toBeLessThanOrEqual(250);
    });

    it("ensures total catalog size across all six tools is <= 1500 bytes", () => {
      const catalog = formatModelFacingToolCatalog(INITIAL_TOOL_DEFINITIONS);
      const totalCatalogBytes = Buffer.byteLength(catalog, "utf8");
      expect(totalCatalogBytes).toBeLessThanOrEqual(1500);
    });

    it("prints per-tool metrics table", () => {
      let totalBytes = 0;
      for (const tool of INITIAL_TOOL_DEFINITIONS) {
        const inspection = inspectToolProjection(tool);
        totalBytes += inspection.byteLength;
        console.log(
          `TOOL_METRICS: ${inspection.toolName} | ${inspection.byteLength} bytes | SHA256:${inspection.sha256} | ${inspection.formattedProjection}`
        );
      }
      console.log(`TOOL_METRICS_SUMMARY: total=${totalBytes} bytes, avg=${(totalBytes / INITIAL_TOOL_DEFINITIONS.length).toFixed(1)} bytes/tool`);
    });
  });

  // --------------------------------------------------------------------------
  // 7. LiveAgentBrain Integration
  // --------------------------------------------------------------------------
  describe("7. LiveAgentBrain Integration", () => {
    it("embeds standardized tool catalog into user prompt message", () => {
      const provider = new StubModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const snapshot = createMockSnapshot();
      const brainReq = {
        runId: "run-test-1",
        contextSnapshot: snapshot,
        availableTools: staticToolRegistry.listTools(),
        sequenceNumber: 1,
      };

      const modelReq = brain.buildModelRequest(brainReq);
      const userContent = modelReq.input[1]!.content;

      expect(userContent).toContain("## Available Tools");
      for (const tool of INITIAL_TOOL_DEFINITIONS) {
        expect(userContent).toContain(`- ${tool.name}(`);
      }
      expect(userContent).not.toContain("workspace.code.search");
      expect(userContent).not.toContain("capability:");
      expect(userContent).not.toContain("idempotency:");
    });
  });

  // --------------------------------------------------------------------------
  // 8. ProposalValidator Strictness on Invented Arguments
  // --------------------------------------------------------------------------
  describe("8. ProposalValidator Strictness on Invented Arguments", () => {
    const validator = new ProposalValidator();
    const snapshot = createMockSnapshot();
    const contract = createMockContract();
    const run = createMockRun(contract);
    const valCtx: ProposalValidationContext = {
      runId: run.runId,
      contextSnapshot: snapshot,
      run,
      contract,
      leaseId: run.leaseId ?? undefined,
    };

    it("rejects search_code with invented 'pattern' parameter", () => {
      const result = validator.validate(
        {
          proposalId: "prop-search-1",
          toolName: "search_code",
          inputPayload: { pattern: "calculator", filePaths: ["src/calculator.ts"] },
          contextSnapshotHash: snapshot.contextHash,
          rationale: "Search for calculator",
        },
        valCtx
      );

      expect(result.valid).toBe(false);
      expect((result as any).reason).toBe("INVALID_TOOL_INPUT");
    });

    it("accepts search_code with canonical 'query' parameter from projection example", () => {
      const result = validator.validate(
        {
          proposalId: "prop-search-2",
          toolName: "search_code",
          inputPayload: TOOL_SEMANTIC_METADATA.search_code.minimalExample,
          contextSnapshotHash: snapshot.contextHash,
          rationale: "Search for calculator",
        },
        valCtx
      );

      expect(result.valid).toBe(true);
    });

    it("rejects run_command with invented 'command' string parameter", () => {
      const result = validator.validate(
        {
          proposalId: "prop-run-1",
          toolName: "run_command",
          inputPayload: { command: "npm test" },
          contextSnapshotHash: snapshot.contextHash,
          rationale: "Run tests",
        },
        valCtx
      );

      expect(result.valid).toBe(false);
      expect((result as any).reason).toBe("INVALID_TOOL_INPUT");
    });

    it("accepts run_command with canonical 'argv' array parameter from projection example", () => {
      const result = validator.validate(
        {
          proposalId: "prop-run-2",
          toolName: "run_command",
          inputPayload: TOOL_SEMANTIC_METADATA.run_command.minimalExample,
          contextSnapshotHash: snapshot.contextHash,
          rationale: "Run tests",
        },
        valCtx
      );

      expect(result.valid).toBe(true);
    });

    it("rejects write_file with invented 'text' or 'mode' parameters", () => {
      const result = validator.validate(
        {
          proposalId: "prop-write-1",
          toolName: "write_file",
          inputPayload: { path: "src/index.ts", text: "hello", mode: "write" },
          contextSnapshotHash: snapshot.contextHash,
          rationale: "Write index file",
        },
        valCtx
      );

      expect(result.valid).toBe(false);
      expect((result as any).reason).toBe("INVALID_TOOL_INPUT");
    });

    it("accepts write_file with canonical 'path' and 'content' parameters from projection example", () => {
      const result = validator.validate(
        {
          proposalId: "prop-write-2",
          toolName: "write_file",
          inputPayload: TOOL_SEMANTIC_METADATA.write_file.minimalExample,
          contextSnapshotHash: snapshot.contextHash,
          rationale: "Write index file",
        },
        valCtx
      );

      expect(result.valid).toBe(true);
    });
  });
});
