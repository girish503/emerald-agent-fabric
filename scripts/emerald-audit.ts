#!/usr/bin/env node
/**
 * Emerald Standalone Offline Auditor Verification CLI
 *
 * Usage:
 *   npx tsx scripts/emerald-audit.ts verify <path> [--keyring <file>] [--json] [--threshold <N>] [--require-keyring]
 *   npx tsx scripts/emerald-audit.ts inspect <path> [--json]
 *   npx tsx scripts/emerald-audit.ts --help
 *
 * Exit Codes:
 *   0 = VERIFIED / SUCCESS
 *   1 = VERIFICATION_FAILED
 *   2 = INVALID_INPUT
 *   3 = CONFIGURATION_ERROR
 */

import * as path from "node:path";
import * as fs from "node:fs";
import {
  AUDIT_EXIT_CODES,
  DEFAULT_AUDIT_THRESHOLD_POLICY,
  loadTrustedKeyringFromFile,
  OfflineAuditor,
  OfflineAuditorOptions,
} from "../src/application/offline-auditor.js";
import { canonicalJsonStringify } from "../src/domain/canonical-hash.js";

function printUsage(): void {
  console.log(`
Emerald Standalone Offline Auditor Verification CLI

Commands:
  verify <path>    Perform complete offline cryptographic and replay verification
  inspect <path>   Inspect safe metadata from evidence without asserting validity

Options:
  --keyring <file>   Path to trusted keyring JSON file containing trusted public keys
  --json             Output deterministic machine-readable JSON
  --threshold <N>    Threshold of required valid authority signatures (default: 2)
  --require-keyring  Fail verification if no keyring is provided or bundle is unsigned
  --help, -h         Show this help message

Exit Codes:
  0 = VERIFIED (or inspection complete)
  1 = VERIFICATION_FAILED
  2 = INVALID_INPUT
  3 = CONFIGURATION_ERROR
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(AUDIT_EXIT_CODES.INVALID_INPUT);
  }

  let command = "verify";
  let targetPath: string | undefined = undefined;
  let keyringPath: string | undefined = undefined;
  let isJson = false;
  let threshold: number | undefined = undefined;
  let requireKeyring = false;

  let i = 0;
  if (args[0] === "verify" || args[0] === "inspect") {
    command = args[0];
    i = 1;
  }

  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") {
      isJson = true;
    } else if (arg === "--require-keyring") {
      requireKeyring = true;
    } else if (arg === "--keyring") {
      if (i + 1 >= args.length) {
        console.error("Error: --keyring requires a file path argument");
        process.exit(AUDIT_EXIT_CODES.INVALID_INPUT);
      }
      keyringPath = args[++i];
    } else if (arg === "--threshold") {
      if (i + 1 >= args.length) {
        console.error("Error: --threshold requires an integer argument");
        process.exit(AUDIT_EXIT_CODES.INVALID_INPUT);
      }
      const val = parseInt(args[++i]!, 10);
      if (isNaN(val) || val < 1) {
        console.error("Error: --threshold must be a positive integer");
        process.exit(AUDIT_EXIT_CODES.CONFIGURATION_ERROR);
      }
      threshold = val;
    } else if (!arg.startsWith("-")) {
      if (!targetPath) {
        targetPath = arg;
      } else {
        console.error(`Error: Unexpected additional argument '${arg}'`);
        process.exit(AUDIT_EXIT_CODES.INVALID_INPUT);
      }
    } else {
      console.error(`Error: Unknown option '${arg}'`);
      process.exit(AUDIT_EXIT_CODES.INVALID_INPUT);
    }
  }

  if (!targetPath) {
    console.error("Error: Missing evidence target path");
    printUsage();
    process.exit(AUDIT_EXIT_CODES.INVALID_INPUT);
  }

  const resolvedTarget = path.resolve(process.cwd(), targetPath);
  if (!fs.existsSync(resolvedTarget)) {
    console.error(`Error: Target evidence not found: ${resolvedTarget}`);
    process.exit(AUDIT_EXIT_CODES.INVALID_INPUT);
  }

  if (command === "inspect") {
    try {
      const inspection = OfflineAuditor.inspectEvidence(resolvedTarget);
      if (isJson) {
        console.log(canonicalJsonStringify(inspection));
      } else {
        console.log(OfflineAuditor.formatHumanInspection(inspection));
      }
      process.exit(AUDIT_EXIT_CODES.VERIFIED);
    } catch (err: any) {
      console.error(`Inspection Error: ${err?.message ?? "unknown error"}`);
      process.exit(AUDIT_EXIT_CODES.INVALID_INPUT);
    }
  }

  // Handle verify command
  let keyring = undefined;
  if (keyringPath) {
    const resolvedKeyring = path.resolve(process.cwd(), keyringPath);
    try {
      keyring = loadTrustedKeyringFromFile(resolvedKeyring);
    } catch (err: any) {
      console.error(`Configuration Error (Keyring): ${err?.message ?? "unknown error"}`);
      process.exit(AUDIT_EXIT_CODES.CONFIGURATION_ERROR);
    }
  }

  const thresholdPolicy = threshold
    ? { threshold, totalAuthorities: DEFAULT_AUDIT_THRESHOLD_POLICY.totalAuthorities }
    : DEFAULT_AUDIT_THRESHOLD_POLICY;

  const options: OfflineAuditorOptions = {
    keyring,
    thresholdPolicy,
    requireKeyring,
  };

  try {
    const result = OfflineAuditor.verifyEvidence(resolvedTarget, options);

    if (isJson) {
      console.log(canonicalJsonStringify(result));
    } else {
      console.log(OfflineAuditor.formatHumanReport(result));
    }

    if (result.status === "VERIFIED") {
      process.exit(AUDIT_EXIT_CODES.VERIFIED);
    } else {
      process.exit(AUDIT_EXIT_CODES.VERIFICATION_FAILED);
    }
  } catch (err: any) {
    console.error(`Verification Error: ${err?.message ?? "unknown error"}`);
    process.exit(AUDIT_EXIT_CODES.INVALID_INPUT);
  }
}

main().catch((err) => {
  console.error("Unhandled fatal exception:", err);
  process.exit(AUDIT_EXIT_CODES.INVALID_INPUT);
});
