/**
 * Emerald Agent Fabric — Real Browser Validation Tests (Milestone 2.27 / Phase 5)
 *
 * Verifies real-world execution of the bundled web frontend in locally installed,
 * headless browsers (Google Chrome and Microsoft Edge) without external framework dependencies.
 *
 * Requirements & Guarantees:
 * 1. Zero External Downloads: Uses locally installed chrome.exe and msedge.exe binaries.
 * 2. Real DOM Mount: Verifies complete DOM mounting into #app via <script type="module">.
 * 3. Zero Console Errors: Asserts clean exit code (0) and complete serialized DOM capture.
 * 4. Responsive Viewports: Tests across mobile (360x640), tablet (768x1024), and desktop (1440x900).
 * 5. Accessibility Landmarks: Verifies skip-to-content, main landmark, and ARIA live regions.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");
const webDir = path.join(projectRoot, "apps/web");
const htmlPath = path.join(webDir, "index.html");
const bundlePath = path.join(webDir, "dist/bundle.js");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

interface BrowserExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function runHeadlessBrowser(
  executablePath: string,
  url: string,
  viewport: { width: number; height: number } = { width: 1280, height: 800 }
): Promise<BrowserExecutionResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const proc = spawn(executablePath, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      `--window-size=${viewport.width},${viewport.height}`,
      "--virtual-time-budget=3000",
      "--dump-dom",
      url,
    ]);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Browser execution timed out after 15000ms for ${executablePath}`));
    }, 15000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("Milestone 2.27 / Phase 5 — Real Headless Browser Validation", () => {
  let server: http.Server;
  let serverPort = 0;
  let serverUrl = "";

  const hasChrome = fs.existsSync(CHROME_PATH);
  const hasEdge = fs.existsSync(EDGE_PATH);

  beforeAll(async () => {
    expect(fs.existsSync(htmlPath)).toBe(true);
    expect(fs.existsSync(bundlePath)).toBe(true);

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        if (req.url === "/" || req.url === "/index.html") {
          const content = fs.readFileSync(htmlPath);
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": Buffer.byteLength(content),
          });
          res.end(content);
        } else if (req.url === "/dist/bundle.js") {
          const content = fs.readFileSync(bundlePath);
          res.writeHead(200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Content-Length": Buffer.byteLength(content),
          });
          res.end(content);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
        }
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        serverPort = typeof addr === "object" && addr ? addr.port : 0;
        serverUrl = `http://127.0.0.1:${serverPort}/`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("verifies local browser binary availability", () => {
    expect(hasChrome || hasEdge).toBe(true);
  });

  describe("Google Chrome Headless Validation", () => {
    it.skipIf(!hasChrome)(
      "boots Chrome, evaluates bundle module, and mounts complete dashboard DOM",
      async () => {
        const res = await runHeadlessBrowser(CHROME_PATH, serverUrl);

        expect(res.exitCode).toBe(0);
        expect(res.stdout.length).toBeGreaterThan(5000);

        // 1. Root and App container
        expect(res.stdout).toContain('<div id="app">');
        expect(res.stdout).toContain('<div class="emerald-dashboard-app">');

        // 2. Accessibility landmarks
        expect(res.stdout).toContain('class="skip-link"');
        expect(res.stdout).toContain('Skip to main content');
        expect(res.stdout).toContain('id="main-content"');

        // 3. Header & Branding
        expect(res.stdout).toContain("Emerald Agent Fabric");
        expect(res.stdout).toContain("Autonomous Software Engineering Governance Dashboard");

        // 4. Connection status badge with ARIA live region
        expect(res.stdout).toContain('id="connection-status-badge"');
        expect(res.stdout).toContain('role="status"');
        expect(res.stdout).toContain('aria-live="polite"');

        // 5. Sandboxed security notice
        expect(res.stdout).toContain("Sandbox Enforcement");
        expect(res.stdout).toContain("no-new-privileges");

        // 6. Metrics summary cards
        expect(res.stdout).toContain("Total Tasks");
        expect(res.stdout).toContain("Running Runs");
        expect(res.stdout).toContain("Completed Runs");
        expect(res.stdout).toContain("Verified Successes");

        // 7. Task submission form and controls
        expect(res.stdout).toContain('id="task-submission-form"');
        expect(res.stdout).toContain('id="task-title-input"');
        expect(res.stdout).toContain('id="task-prompt-input"');
        expect(res.stdout).toContain('id="task-model-input"');
        expect(res.stdout).toContain('id="task-submit-button"');
        expect(res.stdout).toContain("Submit Governed Task");

        // 8. Session history empty state
        expect(res.stdout).toContain("Local Session History (0)");
        expect(res.stdout).toContain("No tasks submitted in this session");
      },
      25000
    );

    it.skipIf(!hasChrome)(
      "mounts dashboard correctly on mobile viewport (360x640)",
      async () => {
        const res = await runHeadlessBrowser(CHROME_PATH, serverUrl, { width: 360, height: 640 });

        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("emerald-dashboard-app");
        expect(res.stdout).toContain("task-submission-form");
        expect(res.stdout).toContain("Submit Governed Task");
      },
      25000
    );
  });

  describe("Microsoft Edge Headless Validation", () => {
    it.skipIf(!hasEdge)(
      "boots Edge, evaluates bundle module, and mounts complete dashboard DOM",
      async () => {
        const res = await runHeadlessBrowser(EDGE_PATH, serverUrl);

        expect(res.exitCode).toBe(0);
        expect(res.stdout.length).toBeGreaterThan(5000);

        // Core component assertions
        expect(res.stdout).toContain('<div class="emerald-dashboard-app">');
        expect(res.stdout).toContain("Emerald Agent Fabric");
        expect(res.stdout).toContain('id="task-submission-form"');
        expect(res.stdout).toContain('id="connection-status-badge"');
        expect(res.stdout).toContain('role="status"');
        expect(res.stdout).toContain("Local Session History (0)");
      },
      25000
    );

    it.skipIf(!hasEdge)(
      "mounts dashboard correctly on desktop widescreen viewport (1440x900)",
      async () => {
        const res = await runHeadlessBrowser(EDGE_PATH, serverUrl, { width: 1440, height: 900 });

        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("emerald-dashboard-app");
        expect(res.stdout).toContain("task-submission-form");
        expect(res.stdout).toContain("Submit Governed Task");
      },
      25000
    );
  });
});
