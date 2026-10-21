/**
 * Emerald Agent Fabric — Production Configuration System
 *
 * Centralized, type-safe configuration module for the production runtime.
 * Implements safe, zero-cost, local-only defaults:
 * - Local open-source model execution (Ollama)
 * - Zero commercial API keys or cloud dependencies
 * - Bound timeouts and non-clamping resource limits
 * - Hermetic workspace root and WAL-mode SQLite database path
 */

import * as path from "node:path";

export interface ResourceLimitsConfig {
  readonly maxSteps: number;
  readonly maxActions: number;
  readonly maxOutputBytes: number;
  readonly maxMemoryBytes: number;
  readonly maxConsecutiveFailures: number;
}

export interface TimeoutsConfig {
  readonly stepTimeoutMs: number;
  readonly actionTimeoutMs: number;
  readonly modelTimeoutMs: number;
  readonly runTimeoutMs: number;
}

export interface ProductionConfig {
  readonly environment: "production" | "development" | "test";
  readonly modelProvider: "ollama" | "in-process" | "mock";
  readonly model: string;
  readonly ollamaBaseUrl: string;
  readonly executionProvider: "docker" | "in-process";
  readonly workspaceRoot: string;
  readonly dbPath: string;
  readonly timeouts: TimeoutsConfig;
  readonly resourceLimits: ResourceLimitsConfig;
  readonly verificationPolicy: "strict" | "standard";
  readonly loggingLevel: "debug" | "info" | "warn" | "error";
  readonly localOnly: true; // Invariant: no network leakage
}

export const DEFAULT_PRODUCTION_CONFIG: ProductionConfig = {
  environment: "production",
  modelProvider: "ollama",
  model: "qwen2.5-coder:7b",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  executionProvider: "docker",
  workspaceRoot: path.join(process.cwd(), "workspaces"),
  dbPath: path.join(process.cwd(), "emerald-production.sqlite"),
  timeouts: {
    stepTimeoutMs: 30000,
    actionTimeoutMs: 60000,
    modelTimeoutMs: 30000,
    runTimeoutMs: 300000, // 5 minutes
  },
  resourceLimits: {
    maxSteps: 50,
    maxActions: 30,
    maxOutputBytes: 1024 * 1024, // 1 MB
    maxMemoryBytes: 512 * 1024 * 1024, // 512 MB
    maxConsecutiveFailures: 3,
  },
  verificationPolicy: "strict",
  loggingLevel: "info",
  localOnly: true,
};

/**
 * Creates a validated production configuration with optional overrides.
 */
export function createProductionConfig(
  overrides?: Partial<ProductionConfig>,
): ProductionConfig {
  const envModel = process.env["EMERALD_MODEL"];
  const envProvider = process.env["EMERALD_MODEL_PROVIDER"] as ProductionConfig["modelProvider"] | undefined;
  const envExec = process.env["EMERALD_EXECUTION_PROVIDER"] as ProductionConfig["executionProvider"] | undefined;
  const envWorkspace = process.env["EMERALD_WORKSPACE_ROOT"];
  const envDb = process.env["EMERALD_DB_PATH"];
  const envBaseUrl = process.env["OLLAMA_BASE_URL"];

  return {
    ...DEFAULT_PRODUCTION_CONFIG,
    model: overrides?.model ?? envModel ?? DEFAULT_PRODUCTION_CONFIG.model,
    modelProvider: overrides?.modelProvider ?? envProvider ?? DEFAULT_PRODUCTION_CONFIG.modelProvider,
    ollamaBaseUrl: overrides?.ollamaBaseUrl ?? envBaseUrl ?? DEFAULT_PRODUCTION_CONFIG.ollamaBaseUrl,
    executionProvider: overrides?.executionProvider ?? envExec ?? DEFAULT_PRODUCTION_CONFIG.executionProvider,
    workspaceRoot: overrides?.workspaceRoot ?? envWorkspace ?? DEFAULT_PRODUCTION_CONFIG.workspaceRoot,
    dbPath: overrides?.dbPath ?? envDb ?? DEFAULT_PRODUCTION_CONFIG.dbPath,
    timeouts: {
      ...DEFAULT_PRODUCTION_CONFIG.timeouts,
      ...overrides?.timeouts,
    },
    resourceLimits: {
      ...DEFAULT_PRODUCTION_CONFIG.resourceLimits,
      ...overrides?.resourceLimits,
    },
    verificationPolicy: overrides?.verificationPolicy ?? DEFAULT_PRODUCTION_CONFIG.verificationPolicy,
    loggingLevel: overrides?.loggingLevel ?? DEFAULT_PRODUCTION_CONFIG.loggingLevel,
    localOnly: true,
  };
}
