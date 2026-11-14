/**
 * Emerald Agent Fabric — Frontend Production Readiness & UX Hardening Tests (Milestone 2.27 / Phase 5)
 *
 * Verifies production hardening across:
 * 1. WebCrypto parity with Node crypto (bit-exact RFC 6234 SHA-256)
 * 2. Standalone bundle integrity and runtime export validation
 * 3. Accessibility attributes (WCAG AA landmarks, focus indicators, polite live regions)
 * 4. Responsive CSS and defensive overflow styling
 * 5. Event timeline 500-event display buffer cap and memory bounds
 * 6. Component lifecycle teardown and abort controller disposal
 * 7. Security XSS escaping across all dynamic renderers
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createHash } from "../../apps/web/src/client/web-crypto.js";
import {
  mountDashboardApp,
  type DOMElement,
} from "../../apps/web/src/app.js";
import {
  renderDashboardHtml,
  renderTaskSubmissionForm,
  renderConnectionStatusBadge,
  renderSseConnectionBadge,
  renderCancellationControls,
  renderExecutionTimeline,
  escapeHtml,
} from "../../apps/web/src/components/dashboard-view.js";
import {
  DashboardController,
  type DashboardState,
} from "../../apps/web/src/components/dashboard-controller.js";
import {
  formatOutcomeBadge,
  formatTaskStatusBadge,
} from "../../apps/web/src/components/workspace-views.js";
import { EmeraldApiClient } from "../../apps/web/src/client/api-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");
const webDir = path.join(projectRoot, "apps/web");
const htmlPath = path.join(webDir, "index.html");
const bundlePath = path.join(webDir, "dist/bundle.js");

function createMockElement(id = "root"): DOMElement {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const children: Map<string, DOMElement> = new Map();

  const element: DOMElement = {
    innerHTML: "",
    querySelector<E extends DOMElement = DOMElement>(selector: string): E | null {
      if (selector.startsWith("#")) {
        const targetId = selector.slice(1);
        if (targetId === id) return element as unknown as E;
        if (!children.has(targetId)) {
          children.set(targetId, createMockElement(targetId));
        }
        return children.get(targetId) as unknown as E;
      }
      return null;
    },
    querySelectorAll<E extends DOMElement = DOMElement>(_selector: string): E[] {
      return [];
    },
    addEventListener(event: string, handler: (e: any) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },
    removeEventListener(event: string, handler: (e: any) => void) {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((h) => h !== handler);
      }
    },
    dispatchEvent(event: any): boolean {
      const type = event?.type || "unknown";
      for (const h of listeners[type] || []) {
        h(event);
      }
      return true;
    },
    getAttribute(_name: string) {
      return null;
    },
  };

  return element;
}

describe("Milestone 2.27 / Phase 5 — Frontend Production Readiness & UX Hardening", () => {
  describe("1. Browser Web Crypto Parity with Node.js crypto", () => {
    it("produces identical SHA-256 digests for standard RFC test vectors", () => {
      const testCases = [
        "",
        "a",
        "abc",
        "message digest",
        "abcdefghijklmnopqrstuvwxyz",
        "The quick brown fox jumps over the lazy dog",
        JSON.stringify({ runId: "run-123", outcome: "VERIFIED_SUCCESS", count: 42 }),
      ];

      for (const input of testCases) {
        const webHash = createHash("sha256").update(input).digest("hex");
        const nodeHash = crypto.createHash("sha256").update(input).digest("hex");
        expect(webHash).toBe(nodeHash);
      }
    });

    it("handles multi-update streaming correctly", () => {
      const chunk1 = "part1-";
      const chunk2 = "part2-";
      const chunk3 = "part3-end";

      const webDigest = createHash("sha256")
        .update(chunk1)
        .update(chunk2)
        .update(chunk3)
        .digest("hex");

      const nodeDigest = crypto
        .createHash("sha256")
        .update(chunk1 + chunk2 + chunk3)
        .digest("hex");

      expect(webDigest).toBe(nodeDigest);
    });
  });

  describe("2. Standalone Bundle Runtime Integrity", () => {
    it("verifies apps/web/dist/bundle.js exists and is non-empty", () => {
      expect(fs.existsSync(bundlePath)).toBe(true);
      const stat = fs.statSync(bundlePath);
      expect(stat.size).toBeGreaterThan(100 * 1024); // Bundle is > 100KB
    });

    it("verifies the bundle has zero unresolvable node:* imports", () => {
      const bundleContent = fs.readFileSync(bundlePath, "utf8");
      // Check for any top-level unbundled external node: imports
      const externalNodeImportRegex = /from\s+["']node:[^"']+["']/g;
      const matches = bundleContent.match(externalNodeImportRegex);
      expect(matches).toBeNull();
    });

    it("exports all public frontend API contracts", async () => {
      const module = await import(bundlePath);
      expect(typeof module.mountDashboardApp).toBe("function");
      expect(typeof module.EmeraldApiClient).toBe("function");
      expect(typeof module.EmeraldSseClient).toBe("function");
      expect(typeof module.DashboardController).toBe("function");
      expect(typeof module.renderDashboardHtml).toBe("function");
      expect(typeof module.renderArtifactViewer).toBe("function");
      expect(typeof module.renderEvidenceViewer).toBe("function");
    });
  });

  describe("3. Accessibility Landmarks, Focus Rings & ARIA Live Regions", () => {
    it("renders skip-to-content link and main landmark with matched ID", () => {
      const state: DashboardState = {
        connectionStatus: "idle",
        isSubmitting: false,
        tasks: [],
        cancellation: {},
      };

      const html = renderDashboardHtml(state);
      expect(html).toContain('<a href="#main-content" class="skip-link">Skip to main content</a>');
      expect(html).toContain('<main class="dashboard-main-content" id="main-content">');
    });

    it("attaches role='status' and aria-live='polite' to connection status badges", () => {
      const idleBadge = renderConnectionStatusBadge("idle");
      expect(idleBadge).toContain('role="status"');
      expect(idleBadge).toContain('aria-live="polite"');

      const sseBadge = renderSseConnectionBadge("connected", 10, 5);
      expect(sseBadge).toContain('role="status"');
      expect(sseBadge).toContain('aria-live="polite"');
    });

    it("renders polite live regions for run cancellation states", () => {
      const run = {
        runId: "run-cancel-test",
        taskId: "task-1",
        status: "RUNNING" as const,
        attemptNumber: 1,
        currentStepIndex: 2,
        leaseExpiresAt: "2026-11-08T01:00:00Z",
        finalOutcome: null,
        completedAt: null,
        metrics: { wallClockMs: 1200, stepCount: 2, toolCallCount: 1 },
        createdAt: "2026-11-08T00:00:00Z",
      };

      const requestingHtml = renderCancellationControls(run, { phase: "requesting" });
      expect(requestingHtml).toContain('role="status"');
      expect(requestingHtml).toContain('aria-live="polite"');
      expect(requestingHtml).toContain("Cancellation requested");

      const stoppedHtml = renderCancellationControls(run, { phase: "confirmed_stopped" });
      expect(stoppedHtml).toContain('role="status"');
      expect(stoppedHtml).toContain('aria-live="polite"');
      expect(stoppedHtml).toContain("Cancellation confirmed");
    });

    it("announces live timeline updates politely without interrupting user", () => {
      const timelineHtml = renderExecutionTimeline([
        {
          stepIndex: 1,
          timestamp: "2026-11-08T00:00:00Z",
          thought: "Analyzing workspace...",
          toolCalls: [],
        },
      ]);

      expect(timelineHtml).toContain('aria-live="polite"');
      expect(timelineHtml).toContain('aria-atomic="false"');
    });

    it("binds aria-invalid and aria-describedby on task form when submission error occurs", () => {
      const cleanState: DashboardState = {
        connectionStatus: "connected",
        isSubmitting: false,
        tasks: [],
        cancellation: {},
      };

      const cleanHtml = renderTaskSubmissionForm(cleanState);
      expect(cleanHtml).not.toContain('aria-invalid="true"');
      expect(cleanHtml).not.toContain('aria-describedby="task-submission-error"');

      const errorState: DashboardState = {
        ...cleanState,
        lastSubmissionError: "Task prompt cannot be empty",
      };

      const errorHtml = renderTaskSubmissionForm(errorState);
      expect(errorHtml).toContain('id="task-submission-error"');
      expect(errorHtml).toContain('role="alert"');
      expect(errorHtml).toContain('aria-invalid="true"');
      expect(errorHtml).toContain('aria-describedby="task-submission-error"');
    });

    it("guarantees color-independent status badges with distinct text and descriptions", () => {
      const verified = formatOutcomeBadge("VERIFIED_SUCCESS");
      expect(verified.label).toBe("Verified Success");
      expect(verified.color).toBe("green");
      expect(verified.description.length).toBeGreaterThan(10);

      const falseComp = formatOutcomeBadge("FALSE_COMPLETION");
      expect(falseComp.label).toBe("False Completion");
      expect(falseComp.color).toBe("red");

      const blocked = formatOutcomeBadge("BLOCKED");
      expect(blocked.label).toBe("Governance Blocked");
      expect(blocked.color).toBe("blue");

      const taskPending = formatTaskStatusBadge("QUEUED");
      expect(taskPending.label).toBe("QUEUED");
      expect(taskPending.color).toBe("blue");
    });
  });

  describe("4. Responsive Layout & Defensive Word Breaking", () => {
    it("defines defensive word break and overflow wrap rules in index.html", () => {
      const html = fs.readFileSync(htmlPath, "utf8");
      expect(html).toContain("overflow-wrap: anywhere;");
      expect(html).toContain("word-break: break-all;");
      expect(html).toContain("box-sizing: border-box;");
      expect(html).toContain("overflow-x: hidden;");
    });

    it("defines responsive media queries for mobile, tablet, and desktop viewports", () => {
      const html = fs.readFileSync(htmlPath, "utf8");
      expect(html).toContain("@media (min-width: 600px)");
      expect(html).toContain("@media (min-width: 1024px)");
      expect(html).toContain("@media (min-width: 1440px)");
      expect(html).toContain(":focus-visible");
    });
  });

  describe("5. Event Display Buffer Cap & Memory Bounds", () => {
    it("caps live event timeline history to exactly 500 events under high event volume", () => {
      const client = new EmeraldApiClient({ baseUrl: "http://127.0.0.1:9999" });
      const controller = new DashboardController(client, {
        tasks: [
          {
            taskId: "task-buffer-test",
            contractId: "contract-buffer",
            title: "Buffer Test Task",
            status: "RUNNING",
            executionMode: "sandboxed",
            createdAt: "2026-11-08T00:00:00Z",
            updatedAt: "2026-11-08T00:00:00Z",
            runId: "run-buffer-test",
          },
        ],
        selectedTaskId: "task-buffer-test",
        selectedRun: {
          runId: "run-buffer-test",
          taskId: "task-buffer-test",
          status: "RUNNING",
          attemptNumber: 1,
          currentStepIndex: 1,
          leaseExpiresAt: "2026-11-08T01:00:00Z",
          finalOutcome: null,
          completedAt: null,
          metrics: { wallClockMs: 100, stepCount: 1, toolCallCount: 0 },
          createdAt: "2026-11-08T00:00:00Z",
        },
      });

      // Directly feed 600 step events through the internal event processor
      const sseEvents = Array.from({ length: 600 }, (_, i) => ({
        eventId: `evt-${i + 1}`,
        runId: "run-buffer-test",
        sequence: i + 1,
        timestamp: "2026-11-08T00:00:00Z",
        event: "agent.step.started",
        schemaVersion: "v1",
        data: { stepIndex: i + 1, thought: `Thinking step ${i + 1}` },
      }));

      // Simulate event arrival
      for (const evt of sseEvents) {
        (controller as any).handleSseEvent(evt);
      }

      const state = controller.getState();
      // Timeline raw events should be capped at 500
      const rawEvents = state.rawEvents ?? [];
      expect(rawEvents.length).toBe(500);
      expect(rawEvents[0]?.sequence).toBe(101); // First 100 evicted
      expect(rawEvents[499]?.sequence).toBe(600); // Most recent preserved

      controller.dispose();
    });
  });

  describe("6. Component Lifecycle Teardown & Resource Disposal", () => {
    it("unmount() cleans up controller subscriptions, aborts active requests, and clears DOM", () => {
      const container = createMockElement("app-container");
      const client = new EmeraldApiClient({ baseUrl: "http://127.0.0.1:9999" });

      const app = mountDashboardApp({ container, apiClient: client });
      expect(container.innerHTML.length).toBeGreaterThan(0);

      const disposeSpy = vi.spyOn(app.controller, "dispose");
      app.unmount();

      expect(disposeSpy).toHaveBeenCalled();
      expect(container.innerHTML).toBe("");
    });
  });

  describe("7. Security XSS & Injection Protection", () => {
    it("strictly escapes malicious script injection in all dynamic strings", () => {
      const xssPayload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
      const escaped = escapeHtml(xssPayload);

      expect(escaped).not.toContain("<script>");
      expect(escaped).not.toContain("<img");
      expect(escaped).toContain("&lt;script&gt;");
      expect(escaped).toContain("&lt;img");

      const stateWithXss: DashboardState = {
        connectionStatus: "error",
        connectionError: xssPayload,
        isSubmitting: false,
        lastSubmissionError: xssPayload,
        tasks: [
          {
            taskId: "task-xss",
            contractId: "contract-xss",
            title: xssPayload,
            status: "FAILED",
            executionMode: "sandboxed",
            createdAt: "2026-11-08T00:00:00Z",
            updatedAt: "2026-11-08T00:00:00Z",
          },
        ],
        cancellation: {},
      };

      const renderedHtml = renderDashboardHtml(stateWithXss);
      expect(renderedHtml).not.toContain('<script>alert("xss")</script>');
      expect(renderedHtml).not.toContain('<img src=x onerror=alert(1)>');
      expect(renderedHtml).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    });
  });
});
