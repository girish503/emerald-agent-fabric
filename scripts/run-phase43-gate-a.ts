/**
 * Phase 43 — Gate A Feasibility Diagnostic Script
 *
 * Evaluates candidate models against frozen Gate A:
 * - frozen system prompt
 * - frozen tool catalog
 * - minimal representative task (EAF-BM-01 add(2, 3) off-by-one bug)
 * - strict ActionProposal schema
 *
 * Resource ceiling: 30,000 ms toolTimeoutMs / 120,000 ms stepTimeoutMs.
 */

import * as http from "node:http";
import { performance } from "node:perf_hooks";
import { ActionProposalSchema, ALLOWED_PROPOSAL_KEYS, findForbiddenAuthorityKeys } from "../src/domain/action-proposal.js";
import { staticToolRegistry } from "../src/domain/tool.js";

const CANDIDATE_MODELS = [
  "qwen2.5-coder:1.5b",
  "qwen2.5:1.5b",
  "gemma3:1b",
];

const SYSTEM_PROMPT = `You are an autonomous software engineering agent for Emerald Agent Fabric.
Your task is to fix defects in software repositories.
You must interact with the environment strictly by emitting JSON proposals adhering to the ActionProposal schema.
Do NOT output markdown, markdown backticks, or explanation.
Output ONLY a single raw JSON object conforming to:
{
  "proposalId": string,
  "toolName": "read_file" | "write_file" | "run_command",
  "inputPayload": object,
  "contextSnapshotHash": string,
  "rationale": string (optional),
  "sequenceHint": number (optional)
}
Available tools:
- read_file: { "path": string, "offsetLine": number (optional), "limitLines": number (optional) }
- write_file: { "path": string, "content": string }
- run_command: { "command": string }
`;

const USER_TASK_PROMPT = `Task: EAF-BM-01
Repository: emerald/calc
Target: src/calc.js
Problem: add(2, 3) returns -1 instead of 5. Fix the implementation in src/calc.js.
Emit your initial action proposal in raw JSON.
`;

async function queryOllama(model: string, timeoutMs: number = 120000): Promise<{
  statusCode: number;
  durationMs: number;
  rawResponse: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    const start = performance.now();
    const reqData = JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: USER_TASK_PROMPT },
      ],
      stream: false,
      options: {
        temperature: 0.0,
        num_predict: 512,
      },
    });

    const req = http.request(
      {
        hostname: "localhost",
        port: 11434,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(reqData),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          const durationMs = Math.round(performance.now() - start);
          try {
            const parsed = JSON.parse(body);
            resolve({
              statusCode: res.statusCode ?? 200,
              durationMs,
              rawResponse: parsed.message?.content ?? "",
            });
          } catch (e: any) {
            resolve({
              statusCode: res.statusCode ?? 200,
              durationMs,
              rawResponse: body,
              error: `JSON parse error: ${e.message}`,
            });
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      const durationMs = Math.round(performance.now() - start);
      resolve({
        statusCode: 408,
        durationMs,
        rawResponse: "",
        error: `Request timed out after ${timeoutMs}ms`,
      });
    });

    req.on("error", (err) => {
      const durationMs = Math.round(performance.now() - start);
      resolve({
        statusCode: 500,
        durationMs,
        rawResponse: "",
        error: err.message,
      });
    });

    req.write(reqData);
    req.end();
  });
}

function extractJson(text: string): string {
  // Strip markdown code fences if present
  let clean = text.trim();
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return clean.slice(firstBrace, lastBrace + 1);
  }
  return clean;
}

async function run() {
  console.log("================================================================================");
  console.log("PHASE 43: GATE A FEASIBILITY AUDIT ACROSS LOCAL OPEN-WEIGHT MODELS");
  console.log("================================================================================\n");

  const results: any[] = [];

  for (const model of CANDIDATE_MODELS) {
    process.stdout.write(`Evaluating ${model.padEnd(20)} ... `);
    const res = await queryOllama(model, 120000);

    if (res.error && res.statusCode === 408) {
      console.log(`[TIMEOUT] ${res.durationMs}ms > 120000ms ceiling -> ENVIRONMENT_FAILURE`);
      results.push({
        model,
        durationMs: res.durationMs,
        classification: "ENVIRONMENT_FAILURE",
        reason: "Exceeded 120,000 ms step response ceiling",
        proposalValid: false,
        toolGrounded: false,
      });
      continue;
    }

    if (res.error) {
      console.log(`[ERROR] ${res.error}`);
      results.push({
        model,
        durationMs: res.durationMs,
        classification: "MODEL_FAILURE",
        reason: res.error,
        proposalValid: false,
        toolGrounded: false,
      });
      continue;
    }

    // Attempt to extract and validate ActionProposal
    const jsonStr = extractJson(res.rawResponse);
    let parsedJson: any = null;
    let parseError = false;
    try {
      parsedJson = JSON.parse(jsonStr);
    } catch {
      parseError = true;
    }

    let proposalValid = false;
    let toolGrounded = false;
    let schemaErrors: string[] = [];

    if (!parseError && parsedJson && typeof parsedJson === "object") {
      const forbidden = findForbiddenAuthorityKeys(parsedJson);
      if (forbidden.length > 0) {
        schemaErrors.push(`Forbidden authority keys: ${forbidden.join(", ")}`);
      }

      // Check toolName
      const toolDef = staticToolRegistry.getTool(parsedJson.toolName);
      if (toolDef) {
        toolGrounded = true;
        // Validate inputPayload against tool input schema
        const toolValidation = toolDef.inputSchema.safeParse(parsedJson.inputPayload);
        if (toolValidation.success) {
          proposalValid = true;
        } else {
          schemaErrors.push(`Tool payload schema error: ${toolValidation.error.message}`);
        }
      } else {
        schemaErrors.push(`Unknown or ungrounded toolName: ${parsedJson.toolName}`);
      }
    } else {
      schemaErrors.push("Output is not valid JSON");
    }

    console.log(
      `[${res.durationMs}ms] Valid: ${proposalValid ? "YES" : "NO"} | Grounded: ${toolGrounded ? "YES" : "NO"}`
    );

    results.push({
      model,
      durationMs: res.durationMs,
      classification: proposalValid ? "GATE_A_PASSED" : "GATE_A_FAILED",
      proposalValid,
      toolGrounded,
      schemaErrors,
      rawSnippet: res.rawResponse.slice(0, 150).replace(/\n/g, " "),
    });
  }

  console.log("\n--------------------------------------------------------------------------------");
  console.log("GATE A AUDIT SUMMARY:");
  console.log("--------------------------------------------------------------------------------");
  for (const r of results) {
    console.log(
      `${r.model.padEnd(20)} | ${r.classification.padEnd(16)} | ${(r.durationMs / 1000).toFixed(1)}s | Grounded: ${r.toolGrounded ? "YES" : "NO "} | Valid: ${r.proposalValid ? "YES" : "NO "}`
    );
    if (r.schemaErrors && r.schemaErrors.length > 0) {
      console.log(`   Errors: ${r.schemaErrors.join("; ")}`);
    }
    if (r.rawSnippet) {
      console.log(`   Snippet: ${r.rawSnippet}`);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
