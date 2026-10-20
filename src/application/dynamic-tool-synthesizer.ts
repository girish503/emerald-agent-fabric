/**
 * Phase 86 — Governed Dynamic Tool Synthesizer
 *
 * Synthesizes tool proposals across 8 tool classes and 4 provenance conditions.
 * Enforces strict capability boundaries and safe code generation templates.
 */

import {
  DynamicToolClass,
  ToolProvenanceCondition,
  DynamicToolProposal,
  AllowedToolCapability,
} from "../domain/dynamic-tool.js";

export interface ToolClassTemplate {
  readonly toolClass: DynamicToolClass;
  readonly defaultName: string;
  readonly description: string;
  readonly capabilities: readonly AllowedToolCapability[];
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly generateSource: (condition: ToolProvenanceCondition) => string;
}

export const TOOL_CLASS_TEMPLATES: Record<DynamicToolClass, ToolClassTemplate> = {
  AST_ANALYZER: {
    toolClass: "AST_ANALYZER",
    defaultName: "ast-syntax-analyzer",
    description: "Inspects source files for syntax nodes, token counts, and lexical complexity.",
    capabilities: ["READ_WORKSPACE", "READ_AST", "EXECUTE_ANALYSIS"],
    inputSchema: {
      type: "object",
      properties: {
        targetFile: { type: "string" },
        maxDepth: { type: "number" },
      },
      required: ["targetFile"],
    },
    outputSchema: {
      type: "object",
      properties: {
        nodeCount: { type: "number" },
        depth: { type: "number" },
        syntaxValid: { type: "boolean" },
      },
      required: ["nodeCount", "syntaxValid"],
    },
    generateSource: (cond) => `
// Synthesized AST Analyzer (${cond})
export function analyze(input, context) {
  const file = input.targetFile;
  const isTs = file.endsWith(".ts") || file.endsWith(".js");
  return {
    nodeCount: isTs ? 128 : 32,
    depth: 6,
    syntaxValid: true,
    file,
  };
}
`,
  },

  DEPENDENCY_ANALYZER: {
    toolClass: "DEPENDENCY_ANALYZER",
    defaultName: "module-dependency-analyzer",
    description: "Evaluates module dependencies and cyclical import graphs.",
    capabilities: ["READ_WORKSPACE", "READ_DEPENDENCY_GRAPH", "EXECUTE_ANALYSIS"],
    inputSchema: {
      type: "object",
      properties: {
        entrypoint: { type: "string" },
      },
      required: ["entrypoint"],
    },
    outputSchema: {
      type: "object",
      properties: {
        directDependencies: { type: "array" },
        cyclesDetected: { type: "boolean" },
      },
      required: ["directDependencies", "cyclesDetected"],
    },
    generateSource: (cond) => `
// Synthesized Dependency Analyzer (${cond})
export function analyze(input, context) {
  return {
    directDependencies: ["./domain/action.js", "./domain/canonical-hash.js"],
    cyclesDetected: false,
    entrypoint: input.entrypoint,
  };
}
`,
  },

  API_COMPATIBILITY_CHECKER: {
    toolClass: "API_COMPATIBILITY_CHECKER",
    defaultName: "api-signature-checker",
    description: "Verifies exported function signatures and interface compatibility.",
    capabilities: ["READ_WORKSPACE", "READ_AST", "EXECUTE_ANALYSIS"],
    inputSchema: {
      type: "object",
      properties: {
        interfaceName: { type: "string" },
        symbolNames: { type: "array" },
      },
      required: ["interfaceName"],
    },
    outputSchema: {
      type: "object",
      properties: {
        compatible: { type: "boolean" },
        missingSymbols: { type: "array" },
      },
      required: ["compatible"],
    },
    generateSource: (cond) => `
// Synthesized API Compatibility Checker (${cond})
export function analyze(input, context) {
  return {
    compatible: true,
    missingSymbols: [],
    interfaceChecked: input.interfaceName,
  };
}
`,
  },

  SCHEMA_COMPARATOR: {
    toolClass: "SCHEMA_COMPARATOR",
    defaultName: "json-schema-comparator",
    description: "Compares JSON schema specifications for structural backward compatibility.",
    capabilities: ["READ_WORKSPACE", "EXECUTE_ANALYSIS"],
    inputSchema: {
      type: "object",
      properties: {
        baseSchemaVersion: { type: "string" },
        targetSchemaVersion: { type: "string" },
      },
      required: ["baseSchemaVersion", "targetSchemaVersion"],
    },
    outputSchema: {
      type: "object",
      properties: {
        isBackwardCompatible: { type: "boolean" },
        breakingChanges: { type: "array" },
      },
      required: ["isBackwardCompatible"],
    },
    generateSource: (cond) => `
// Synthesized Schema Comparator (${cond})
export function analyze(input, context) {
  return {
    isBackwardCompatible: true,
    breakingChanges: [],
    diffCount: 0,
  };
}
`,
  },

  CONFIGURATION_ANALYZER: {
    toolClass: "CONFIGURATION_ANALYZER",
    defaultName: "package-config-analyzer",
    description: "Validates package.json, tsconfig.json, and tool configurations.",
    capabilities: ["READ_WORKSPACE", "EXECUTE_ANALYSIS"],
    inputSchema: {
      type: "object",
      properties: {
        configPath: { type: "string" },
      },
      required: ["configPath"],
    },
    outputSchema: {
      type: "object",
      properties: {
        valid: { type: "boolean" },
        compilerOptions: { type: "object" },
      },
      required: ["valid"],
    },
    generateSource: (cond) => `
// Synthesized Configuration Analyzer (${cond})
export function analyze(input, context) {
  return {
    valid: true,
    compilerOptions: { strict: true, target: "ES2022" },
    checkedFile: input.configPath,
  };
}
`,
  },

  TEST_IMPACT_ANALYZER: {
    toolClass: "TEST_IMPACT_ANALYZER",
    defaultName: "test-impact-estimator",
    description: "Estimates affected test files based on modified AST symbols.",
    capabilities: ["READ_WORKSPACE", "READ_TEST_METADATA", "EXECUTE_ANALYSIS"],
    inputSchema: {
      type: "object",
      properties: {
        changedFiles: { type: "array" },
      },
      required: ["changedFiles"],
    },
    outputSchema: {
      type: "object",
      properties: {
        impactedTests: { type: "array" },
        estimatedDurationMs: { type: "number" },
      },
      required: ["impactedTests"],
    },
    generateSource: (cond) => `
// Synthesized Test Impact Analyzer (${cond})
export function analyze(input, context) {
  const tests = (input.changedFiles || []).map(f => f.replace("src/", "tests/").replace(".ts", ".test.ts"));
  return {
    impactedTests: tests,
    estimatedDurationMs: 450,
  };
}
`,
  },

  CROSS_REPO_CONTRACT_CHECKER: {
    toolClass: "CROSS_REPO_CONTRACT_CHECKER",
    defaultName: "cross-repo-contract-auditor",
    description: "Checks inter-repository contract alignment and revision freshness.",
    capabilities: ["READ_WORKSPACE", "READ_REPOSITORY", "EXECUTE_ANALYSIS"],
    inputSchema: {
      type: "object",
      properties: {
        producerRepo: { type: "string" },
        consumerRepo: { type: "string" },
      },
      required: ["producerRepo", "consumerRepo"],
    },
    outputSchema: {
      type: "object",
      properties: {
        contractAligned: { type: "boolean" },
        divergentSymbols: { type: "array" },
      },
      required: ["contractAligned"],
    },
    generateSource: (cond) => `
// Synthesized Cross-Repo Contract Checker (${cond})
export function analyze(input, context) {
  return {
    contractAligned: true,
    divergentSymbols: [],
    producer: input.producerRepo,
    consumer: input.consumerRepo,
  };
}
`,
  },

  MIGRATION_IMPACT_ANALYZER: {
    toolClass: "MIGRATION_IMPACT_ANALYZER",
    defaultName: "migration-readiness-analyzer",
    description: "Identifies deprecated APIs and breaking version migrations.",
    capabilities: ["READ_WORKSPACE", "READ_AST", "EXECUTE_ANALYSIS"],
    inputSchema: {
      type: "object",
      properties: {
        targetVersion: { type: "string" },
      },
      required: ["targetVersion"],
    },
    outputSchema: {
      type: "object",
      properties: {
        readinessScore: { type: "number" },
        deprecatedCalls: { type: "array" },
      },
      required: ["readinessScore"],
    },
    generateSource: (cond) => `
// Synthesized Migration Impact Analyzer (${cond})
export function analyze(input, context) {
  return {
    readinessScore: 0.98,
    deprecatedCalls: [],
    target: input.targetVersion,
  };
}
`,
  },
};

export class DynamicToolSynthesizer {
  public synthesizeProposal(
    toolClass: DynamicToolClass,
    condition: ToolProvenanceCondition,
    options: {
      readonly workflowId: string;
      readonly creatorIdentity?: string;
      readonly workspaceScopes?: readonly string[];
      readonly repositoryScopes?: readonly string[];
    }
  ): DynamicToolProposal {
    const template = TOOL_CLASS_TEMPLATES[toolClass];
    if (!template) {
      throw new Error(`Unknown tool class '${toolClass}'.`);
    }

    const proposalId = `tool-prop-${toolClass.toLowerCase().replace(/_/g, "-")}-${condition.toLowerCase().replace(/_/g, "-")}`;
    const sourceCode = template.generateSource(condition).trim();

    return {
      proposalId,
      workflowId: options.workflowId,
      creatorIdentity: options.creatorIdentity || "governed-synthesizer",
      toolName: `${template.defaultName}-${condition.toLowerCase().replace(/_/g, "-")}`,
      toolClass,
      description: `${template.description} (Provenance: ${condition})`,
      sourceCode,
      inputSchema: template.inputSchema,
      outputSchema: template.outputSchema,
      requestedCapabilities: template.capabilities,
      workspaceScopes: options.workspaceScopes || ["workspace/default"],
      repositoryScopes: options.repositoryScopes || ["repo-main"],
      provenanceCondition: condition,
    };
  }

  public getAllToolClasses(): readonly DynamicToolClass[] {
    return Object.keys(TOOL_CLASS_TEMPLATES) as readonly DynamicToolClass[];
  }
}
