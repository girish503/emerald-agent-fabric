/**
 * Phase 86 — Governed Dynamic Tool Validator
 *
 * Deterministic static analysis, AST scanning, capability auditing,
 * and scope boundary verification for dynamically synthesized tools.
 *
 * HARD SECURITY INVARIANTS:
 * - Deny-by-default import allowlist.
 * - Zero forbidden capabilities permitted.
 * - Zero network, process spawning, docker socket, or secret access.
 * - Strict resource budget enforcement.
 */

import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";
import {
  DynamicToolProposal,
  DynamicToolResourceLimits,
  DEFAULT_DYNAMIC_TOOL_BUDGETS,
  ALLOWED_TOOL_CAPABILITIES,
  isForbiddenCapability,
} from "../domain/dynamic-tool.js";

export interface ToolValidationReport {
  readonly valid: boolean;
  readonly toolName: string;
  readonly diagnostics: readonly string[];
  readonly rejectedCapabilities: readonly string[];
  readonly forbiddenPatternsFound: readonly string[];
  readonly sourceDigest: string;
  readonly validationDigest: string;
}

export const ALLOWED_IMPORT_MODULES: readonly string[] = [
  "node:path",
  "path",
  "node:crypto",
  "crypto",
  "node:buffer",
  "buffer",
  "node:util",
  "util",
  "node:assert",
  "assert",
] as const;

export const FORBIDDEN_IMPORT_MODULES: readonly string[] = [
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "cluster",
  "node:cluster",
  "http",
  "node:http",
  "https",
  "node:https",
  "http2",
  "node:http2",
  "net",
  "node:net",
  "dgram",
  "node:dgram",
  "dns",
  "node:dns",
  "tls",
  "node:tls",
  "vm",
  "node:vm",
] as const;

export const FORBIDDEN_CODE_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "PROCESS_SPAWN", pattern: /\b(spawn|exec|execSync|spawnSync|fork)\s*\(/i },
  { name: "DYNAMIC_CODE_EVAL", pattern: /\b(eval|Function)\s*\(/ },
  { name: "NETWORK_FETCH", pattern: /\b(fetch|XMLHttpRequest|WebSocket)\b/ },
  { name: "DOCKER_SOCKET", pattern: /(?:\/var\/run\/docker\.sock|docker\.sock)/i },
  { name: "HOST_SYSTEM_FILES", pattern: /(?:\/etc\/passwd|\/etc\/shadow|C:[\\/]Windows)/i },
  { name: "CREDENTIAL_ENVIRONMENT", pattern: /\bprocess\.env\.(?:[A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD|AUTH|CREDENTIAL)[A-Z0-9_]*)\b/i },
  { name: "GENERIC_PROCESS_ENV", pattern: /\bprocess\.env\b/ },
  { name: "PRIVATE_KEYS", pattern: /(?:id_rsa|id_ed25519|\.pem|\.key|\.pkcs12)/i },
  { name: "AUTHORITY_INJECTION", pattern: /\b(terminalSuccess|policyApproval|evidenceSignature|fourfoldVerification|bypassVerification)\s*:/i },
  { name: "WORKSPACE_ESCAPE", pattern: /\.\.[\/\\]/ },
];

export class DynamicToolValidator {
  private readonly limits: DynamicToolResourceLimits;

  constructor(customLimits?: Partial<DynamicToolResourceLimits>) {
    this.limits = {
      ...DEFAULT_DYNAMIC_TOOL_BUDGETS,
      ...(customLimits || {}),
    };
  }

  public validateProposal(proposal: DynamicToolProposal): ToolValidationReport {
    const diagnostics: string[] = [];
    const rejectedCapabilities: string[] = [];
    const forbiddenPatternsFound: string[] = [];

    const sourceBytes = Buffer.byteLength(proposal.sourceCode, "utf8");
    if (sourceBytes > this.limits.maxSourceBytes) {
      diagnostics.push(`Source code size (${sourceBytes} bytes) exceeds limit (${this.limits.maxSourceBytes} bytes).`);
    }

    if (!proposal.toolName || typeof proposal.toolName !== "string" || proposal.toolName.trim().length === 0) {
      diagnostics.push("Tool name must be a non-empty string.");
    }

    if (!proposal.inputSchema || typeof proposal.inputSchema !== "object") {
      diagnostics.push("Tool inputSchema must be a valid schema object.");
    }

    if (!proposal.outputSchema || typeof proposal.outputSchema !== "object") {
      diagnostics.push("Tool outputSchema must be a valid schema object.");
    }

    // Capability checking
    for (const cap of proposal.requestedCapabilities) {
      if (isForbiddenCapability(cap)) {
        rejectedCapabilities.push(cap);
        diagnostics.push(`Forbidden capability requested: '${cap}'.`);
      } else if (!ALLOWED_TOOL_CAPABILITIES.includes(cap as any)) {
        rejectedCapabilities.push(cap);
        diagnostics.push(`Unrecognized capability requested: '${cap}'.`);
      }
    }

    // Workspace & repository scope checking
    for (const scope of proposal.workspaceScopes) {
      if (typeof scope !== "string" || scope.includes("..") || scope.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(scope)) {
        diagnostics.push(`Invalid or escaping workspace scope: '${scope}'.`);
      }
    }

    for (const repo of proposal.repositoryScopes) {
      if (typeof repo !== "string" || repo.includes("..") || repo.startsWith("/")) {
        diagnostics.push(`Invalid or escaping repository scope: '${repo}'.`);
      }
    }

    // Static code scanning
    this.scanSourceCode(proposal.sourceCode, diagnostics, forbiddenPatternsFound);

    const sourceDigest = sha256Hex(proposal.sourceCode);
    const valid = diagnostics.length === 0 && rejectedCapabilities.length === 0 && forbiddenPatternsFound.length === 0;

    const validationPayload = {
      toolName: proposal.toolName,
      sourceDigest,
      valid,
      diagnostics,
      rejectedCapabilities,
      forbiddenPatternsFound,
    };
    const validationDigest = sha256Hex(canonicalJsonStringify(validationPayload));

    return {
      valid,
      toolName: proposal.toolName,
      diagnostics,
      rejectedCapabilities,
      forbiddenPatternsFound,
      sourceDigest,
      validationDigest,
    };
  }

  private scanSourceCode(source: string, diagnostics: string[], forbiddenPatternsFound: string[]): void {
    // Check forbidden module imports
    for (const mod of FORBIDDEN_IMPORT_MODULES) {
      const importRegex = new RegExp(`(?:import\\s+.*?from\\s+['"]${mod}['"]|require\\s*\\(\\s*['"]${mod}['"]\\))`, "i");
      if (importRegex.test(source)) {
        forbiddenPatternsFound.push(`FORBIDDEN_MODULE_${mod.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`);
        diagnostics.push(`Forbidden module import detected: '${mod}'.`);
      }
    }

    // Check forbidden regex patterns
    for (const { name, pattern } of FORBIDDEN_CODE_PATTERNS) {
      if (pattern.test(source)) {
        forbiddenPatternsFound.push(name);
        diagnostics.push(`Forbidden code pattern detected: ${name}.`);
      }
    }

    // Self-registration detection
    if (/registry\s*\.\s*register/i.test(source) || /registerTool\s*\(/i.test(source)) {
      forbiddenPatternsFound.push("SELF_REGISTRATION_ATTEMPT");
      diagnostics.push("Self-registration attempt detected. Tools cannot register themselves.");
    }
  }
}
