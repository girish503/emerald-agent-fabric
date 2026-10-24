/**
 * Emerald Agent Fabric — Local Ollama Model Adapter
 *
 * Implements local-only, zero-cost inference via Ollama HTTP API.
 * Never accesses external or proprietary cloud model providers.
 *
 * Production V1.8:
 * Supports feature-flagged schema-constrained JSON decoding (`constrainedOutputEnabled`).
 * Local validation enforced even when constrained decoding is requested.
 */

import { AgentProposal, ModelAdapter } from "../../runtime/production-runtime-engine.js";
import {
  getStructuredProposalJsonSchema,
  validateStructuredProposal,
  PROPOSAL_SCHEMA_VERSION,
  getProposalSchemaDigest,
} from "../adapter/structured-proposal-schema.js";

export interface OllamaInferenceMetrics {
  readonly totalDurationMs: number;
  readonly loadDurationMs: number;
  readonly promptEvalDurationMs: number;
  readonly evalDurationMs: number;
  readonly promptEvalCount: number;
  readonly evalCount: number;
  readonly tokensPerSecond: number;
}

export interface OllamaResponseAuditRecord {
  readonly rawResponse: string;
  readonly formatMode: "UNCONSTRAINED_JSON" | "CONSTRAINED_SCHEMA";
  readonly jsonParsed: boolean;
  readonly schemaValid: boolean;
  readonly schemaVersion: string;
  readonly schemaDigest: string;
  readonly toolName?: string;
  readonly validationError?: string;
}

export class OllamaModelAdapter implements ModelAdapter {
  private lastMetrics?: OllamaInferenceMetrics;
  private lastAuditRecord?: OllamaResponseAuditRecord;
  private readonly endpoint: string;

  constructor(
    public readonly modelName: string,
    endpoint: string = "http://localhost:11434",
    private readonly timeoutMs: number = 30000,
    public readonly constrainedOutputEnabled: boolean = false,
  ) {
    this.endpoint = endpoint.replace(/\/$/, "");
  }

  public getLastMetrics(): OllamaInferenceMetrics | undefined {
    return this.lastMetrics;
  }

  public getLastAuditRecord(): OllamaResponseAuditRecord | undefined {
    return this.lastAuditRecord;
  }

  public async proposeAction(contextText: string): Promise<AgentProposal> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const formatPayload = this.constrainedOutputEnabled
      ? getStructuredProposalJsonSchema()
      : "json";

    try {
      const res = await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.modelName,
          prompt: contextText,
          stream: false,
          format: formatPayload,
          options: {
            temperature: 0.1,
            top_p: 0.9,
            num_predict: 512,
          },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Ollama HTTP error ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as {
        response: string;
        total_duration?: number;
        load_duration?: number;
        prompt_eval_duration?: number;
        eval_duration?: number;
        prompt_eval_count?: number;
        eval_count?: number;
      };

      const evalCount = data.eval_count ?? 0;
      const evalDurationMs = (data.eval_duration ?? 0) / 1_000_000;
      const tokensPerSecond = evalDurationMs > 0 ? evalCount / (evalDurationMs / 1000) : 0;

      this.lastMetrics = {
        totalDurationMs: (data.total_duration ?? 0) / 1_000_000 || Date.now() - startTime,
        loadDurationMs: (data.load_duration ?? 0) / 1_000_000,
        promptEvalDurationMs: (data.prompt_eval_duration ?? 0) / 1_000_000,
        evalDurationMs,
        promptEvalCount: data.prompt_eval_count ?? 0,
        evalCount,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
      };

      if (this.constrainedOutputEnabled) {
        return this.parseConstrainedProposal(data.response);
      } else {
        return this.parseUnconstrainedProposal(data.response);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`Ollama inference timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  public parseProposal(rawText: string): AgentProposal {
    return this.parseUnconstrainedProposal(rawText);
  }

  private parseConstrainedProposal(rawText: string): AgentProposal {
    const validation = validateStructuredProposal(rawText);
    let jsonParsed = false;
    let toolName: string | undefined;

    try {
      const parsedObj = JSON.parse(rawText.trim());
      jsonParsed = true;
      toolName = parsedObj.toolName;
    } catch {
      jsonParsed = false;
    }

    this.lastAuditRecord = {
      rawResponse: rawText,
      formatMode: "CONSTRAINED_SCHEMA",
      jsonParsed,
      schemaValid: validation.valid,
      schemaVersion: validation.schemaVersion,
      schemaDigest: validation.schemaDigest,
      toolName: toolName ?? validation.proposal?.toolName,
      validationError: validation.error,
    };

    if (!validation.valid || !validation.proposal) {
      throw new Error(
        `Constrained proposal schema violation [${validation.errorCode ?? "SCHEMA_INVALID"}]: ${validation.error}`,
      );
    }

    return validation.proposal;
  }

  private parseUnconstrainedProposal(rawText: string): AgentProposal {
    let cleaned = rawText.trim();
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    // Try finding the first JSON object
    const startIdx = cleaned.indexOf("{");
    const endIdx = cleaned.lastIndexOf("}");
    if (startIdx !== -1 && endIdx > startIdx) {
      cleaned = cleaned.slice(startIdx, endIdx + 1);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e: any) {
      this.lastAuditRecord = {
        rawResponse: rawText,
        formatMode: "UNCONSTRAINED_JSON",
        jsonParsed: false,
        schemaValid: false,
        schemaVersion: PROPOSAL_SCHEMA_VERSION,
        schemaDigest: getProposalSchemaDigest(),
        validationError: e.message,
      };
      throw new Error(`Failed to parse model output as valid proposal JSON: ${rawText.slice(0, 200)}`);
    }

    const validation = validateStructuredProposal(parsed);
    this.lastAuditRecord = {
      rawResponse: rawText,
      formatMode: "UNCONSTRAINED_JSON",
      jsonParsed: true,
      schemaValid: validation.valid,
      schemaVersion: validation.schemaVersion,
      schemaDigest: validation.schemaDigest,
      toolName: parsed.toolName,
      validationError: validation.error,
    };

    return {
      thought: String(parsed.thought || "Autonomous code repair attempt"),
      toolName: String(parsed.toolName || "read_file"),
      toolInput: parsed.toolInput && typeof parsed.toolInput === "object" ? parsed.toolInput : {},
      isGoalReached: Boolean(parsed.isGoalReached),
    };
  }
}
