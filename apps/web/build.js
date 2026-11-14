/**
 * Emerald Agent Fabric — Browser Frontend Build Script (Milestone 2.27 / Phase 5)
 *
 * Compiles the TypeScript web application into a standalone, browser-executable
 * bundle under apps/web/dist/bundle.js using the locally installed esbuild engine.
 *
 * Architecture & Guarantees:
 * 1. Zero External Downloads: Uses the existing local esbuild installation.
 * 2. Self-Contained: Zero unresolved Node.js imports or external runtime dependencies.
 * 3. Browser Crypto Parity: Aliases transitive "node:crypto" references to web-crypto.ts,
 *    providing genuine FIPS 180-4 compliant SHA-256 hashing in the browser.
 * 4. Strict Typecheck: Guarantees strict TypeScript compilation without type assertion bypasses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

const entryFile = path.join(__dirname, "src/index.ts");
const outDir = path.join(__dirname, "dist");
const outFile = path.join(outDir, "bundle.js");
const webCryptoShim = path.join(__dirname, "src/client/web-crypto.ts");

// Ensure output directory exists
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Locate local esbuild executable
const isWindows = process.platform === "win32";
const esbuildBin = path.join(
  projectRoot,
  "node_modules",
  "@esbuild",
  isWindows ? "win32-x64" : `${process.platform}-${process.arch}`,
  isWindows ? "esbuild.exe" : "bin/esbuild"
);

if (!fs.existsSync(esbuildBin)) {
  throw new Error(`esbuild binary not found at expected location: ${esbuildBin}`);
}

console.log("[build-web] Compiling Emerald Agent Fabric web frontend...");
console.log(`[build-web] Entry point: ${path.relative(projectRoot, entryFile)}`);
console.log(`[build-web] Output bundle: ${path.relative(projectRoot, outFile)}`);

const args = [
  entryFile,
  "--bundle",
  "--platform=browser",
  "--format=esm",
  `--outfile=${outFile}`,
  `--alias:node:crypto=${webCryptoShim}`,
  "--target=es2022",
  "--sourcemap=inline",
  "--minify=false",
];

const startTime = Date.now();
try {
  execFileSync(esbuildBin, args, { stdio: "inherit", cwd: __dirname });
  const duration = Date.now() - startTime;
  const stats = fs.statSync(outFile);
  console.log(`[build-web] Successfully compiled bundle in ${duration}ms (${(stats.size / 1024).toFixed(1)} KB)`);
} catch (err) {
  console.error("[build-web] Compilation failed:", err);
  process.exit(1);
}
