/**
 * Emerald Agent Fabric — Local Ollama Model Adapter
 *
 * Implements local-only, zero-cost inference via Ollama HTTP API.
 * Never accesses external or proprietary cloud model providers.
 */

import { AgentProposal, ModelAdapter } from "../../runtime/production-runtime-engine.js";

export interface OllamaInferenceMetrics {
  readonly totalDurationMs: number;
  readonly loadDurationMs: number;
  readonly promptEvalDurationMs: number;
  readonly evalDurationMs: number;
  readonly promptEvalCount: number;
  readonly evalCount: number;
  readonly tokensPerSecond: number;
}

export class OllamaModelAdapter implements ModelAdapter {
  private lastMetrics?: OllamaInferenceMetrics;
  private readonly endpoint: string;

  constructor(
    public readonly modelName: string,
    endpoint: string = "http://localhost:11434",
    private readonly timeoutMs: number = 30000,
  ) {
    this.endpoint = endpoint.replace(/\/$/, "");
  }

  public getLastMetrics(): OllamaInferenceMetrics | undefined {
    return this.lastMetrics;
  }

  public async proposeAction(contextText: string): Promise<AgentProposal> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.modelName,
          prompt: contextText,
          stream: false,
          format: "json",
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
      const tokensPerSecond = evalDurationMs > 0 ? (evalCount / (evalDurationMs / 1000)) : 0;

      this.lastMetrics = {
        totalDurationMs: (data.total_duration ?? 0) / 1_000_000 || (Date.now() - startTime),
        loadDurationMs: (data.load_duration ?? 0) / 1_000_000,
        promptEvalDurationMs: (data.prompt_eval_duration ?? 0) / 1_000_000,
        evalDurationMs,
        promptEvalCount: data.prompt_eval_count ?? 0,
        evalCount,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
      };

      return this.parseProposal(data.response);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`Ollama inference timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseProposal(rawText: string): AgentProposal {
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

    try {
      const parsed = JSON.parse(cleaned);
      return {
        thought: String(parsed.thought || "Autonomous code repair attempt"),
        toolName: String(parsed.toolName || "read_file"),
        toolInput: (parsed.toolInput && typeof parsed.toolInput === "object") ? parsed.toolInput : {},
        isGoalReached: Boolean(parsed.isGoalReached),
      };
    } catch {
      throw new Error(`Failed to parse model output as valid proposal JSON: ${rawText.slice(0, 200)}`);
    }
  }
}
