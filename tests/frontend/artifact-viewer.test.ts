/**
 * Emerald Agent Fabric — Artifact Visualization & Evidence Viewer Tests (Milestone 2.27 / Phase 4)
 *
 * Covers:
 * 1. Byte size and SHA-256 formatting utilities.
 * 2. MIME and path-based artifact categorization.
 * 3. Artifact Viewer functional HTML rendering:
 *    - Loading, error, empty, and populated states.
 *    - Selected artifact details and content preview limitation notice.
 *    - HTML escaping and untrusted string sanitization.
 * 4. Evidence Viewer functional HTML rendering:
 *    - Authoritative finalOutcome mapping (VERIFIED_SUCCESS, FALSE_COMPLETION, etc.).
 *    - Independent verifier checks and false completion rejection checklists.
 *    - Provenance distinction (INDEPENDENT_OBSERVER vs PROVIDER_REPORTED).
 *    - Invariant disclosure: artifact presence != verification success.
 *    - Operator bypass alert.
 * 5. DashboardController lifecycle integration:
 *    - Automatic artifact loading on run selection.
 *    - Abort and state clearing on rapid run switching.
 *    - Stale response discard protection.
 *    - Reactive artifact selection.
 *    - Live SSE verification event aggregation.
 *    - Unmount and cleanup.
 * 6. Live Fastify REST transport integration:
 *    - 401 unauthenticated, 404 cross-tenant isolation, 200 list artifacts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  formatByteSize,
  formatShortSha,
  categorizeArtifact,
  renderArtifactViewer,
} from "../../apps/web/src/components/artifact-viewer.js";
import {
  renderEvidenceViewer,
  type VerificationRejectedView,
  type RecordedEvidenceView,
  type UnverifiedCompletionAuthorizedView,
} from "../../apps/web/src/components/evidence-viewer.js";
import { DashboardController } from "../../apps/web/src/components/dashboard-controller.js";
import type { ArtifactRecord, SseEventEnvelope } from "../../apps/web/src/types/api.js";
import { buildFastifyServer } from "../../src/transport/http/server.js";

const TEST_RUN_ID = "run-artifact-001";
const TEST_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("Artifact Viewer Utilities", () => {
  describe("formatByteSize", () => {
    it("formats 0 and boundary byte values", () => {
      expect(formatByteSize(0)).toBe("0 B");
      expect(formatByteSize(-5)).toBe("0 B");
      expect(formatByteSize(NaN)).toBe("0 B");
      expect(formatByteSize(512)).toBe("512 B");
      expect(formatByteSize(1023)).toBe("1023 B");
    });

    it("formats kilobytes, megabytes, and gigabytes", () => {
      expect(formatByteSize(1024)).toBe("1.0 KB");
      expect(formatByteSize(1536)).toBe("1.5 KB");
      expect(formatByteSize(1024 * 1024)).toBe("1.0 MB");
      expect(formatByteSize(5 * 1024 * 1024)).toBe("5.0 MB");
      expect(formatByteSize(2 * 1024 * 1024 * 1024)).toBe("2.00 GB");
    });
  });

  describe("formatShortSha", () => {
    it("shortens standard 64-character SHA-256", () => {
      const short = formatShortSha(TEST_SHA256);
      expect(short).toBe("e3b0c442...7852b855");
      expect(short).toHaveLength(19);
    });

    it("handles short or missing hashes gracefully", () => {
      expect(formatShortSha("")).toBe("unknown");
      expect(formatShortSha("abcdef")).toBe("abcdef");
    });
  });

  describe("categorizeArtifact", () => {
    it("identifies patches and diffs", () => {
      const cat1 = categorizeArtifact("text/x-diff", "changes.patch");
      expect(cat1.category).toBe("patch");
      expect(cat1.badgeColor).toBe("blue");

      const cat2 = categorizeArtifact("text/plain", "fix.diff");
      expect(cat2.category).toBe("patch");
    });

    it("identifies configuration and structured JSON", () => {
      const cat = categorizeArtifact("application/json", "manifest.json");
      expect(cat.category).toBe("config");
      expect(cat.badgeColor).toBe("purple");
    });

    it("identifies source code files", () => {
      const cat = categorizeArtifact("text/typescript", "solution.ts");
      expect(cat.category).toBe("code");
      expect(cat.badgeColor).toBe("green");
    });

    it("identifies execution logs", () => {
      const cat = categorizeArtifact("text/plain", "build.log");
      expect(cat.category).toBe("log");
      expect(cat.badgeColor).toBe("yellow");
    });

    it("identifies documentation and markdown", () => {
      const cat = categorizeArtifact("text/markdown", "README.md");
      expect(cat.category).toBe("document");
      expect(cat.badgeColor).toBe("teal");
    });

    it("identifies binary files and archives", () => {
      const cat = categorizeArtifact("application/zip", "bundle.zip");
      expect(cat.category).toBe("binary");
      expect(cat.badgeColor).toBe("gray");
    });

    it("falls back to generic category for unknown types", () => {
      const cat = categorizeArtifact("application/unknown", "data.dat");
      expect(cat.category).toBe("unknown");
      expect(cat.label).toBe("General Artifact");
    });
  });
});

describe("Artifact Viewer Functional HTML Rendering", () => {
  it("renders loading state", () => {
    const html = renderArtifactViewer({ isLoading: true });
    expect(html).toContain("artifact-loading-state");
    expect(html).toContain("Querying registered artifacts");
  });

  it("renders error state safely escaped", () => {
    const errorMsg = 'Failed with <script>alert("xss")</script> & 403 Forbidden';
    const html = renderArtifactViewer({ error: errorMsg });
    expect(html).toContain("artifact-error-state");
    expect(html).toContain("Failed with &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; 403 Forbidden");
    expect(html).not.toContain("<script>");
  });

  it("renders empty state when no artifacts are registered", () => {
    const html = renderArtifactViewer({ artifacts: [] });
    expect(html).toContain("artifact-empty-state");
    expect(html).toContain("No artifacts registered for this run.");
  });

  it("renders list of multiple artifacts with categorized metadata", () => {
    const artifacts: ArtifactRecord[] = [
      {
        artifactId: "art-1",
        runId: TEST_RUN_ID,
        relativePath: "patch.diff",
        sha256: TEST_SHA256,
        byteSize: 2048,
        contentType: "text/x-diff",
        createdAt: "2026-11-08T12:00:00.000Z",
      },
      {
        artifactId: "art-2",
        runId: TEST_RUN_ID,
        relativePath: "manifest.json",
        sha256: "111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000",
        byteSize: 512,
        contentType: "application/json",
        createdAt: "2026-11-08T12:01:00.000Z",
      },
    ];

    const html = renderArtifactViewer({ artifacts });
    expect(html).toContain("2 Artifacts");
    expect(html).toContain("patch.diff");
    expect(html).toContain("manifest.json");
    expect(html).toContain("2.0 KB");
    expect(html).toContain("512 B");
    expect(html).toContain("Patch / Diff");
    expect(html).toContain("Configuration / JSON");
  });

  it("renders selected artifact details with preview unavailability disclosure", () => {
    const artifacts: ArtifactRecord[] = [
      {
        artifactId: "art-patch",
        runId: TEST_RUN_ID,
        relativePath: "exports/patch.diff",
        sha256: TEST_SHA256,
        byteSize: 4096,
        contentType: "text/x-diff",
        createdAt: "2026-11-08T12:00:00.000Z",
      },
    ];

    const html = renderArtifactViewer({
      artifacts,
      selectedArtifactId: "art-patch",
    });

    expect(html).toContain("artifact-selected-details");
    expect(html).toContain("exports/patch.diff");
    expect(html).toContain(TEST_SHA256);
    expect(html).toContain("Content Preview Unavailable");
    expect(html).toContain("separately authorized backend retrieval capability");
  });

  it("strictly escapes untrusted strings in artifact metadata", () => {
    const dangerousArtifact: ArtifactRecord = {
      artifactId: '<svg onload="alert(1)">',
      runId: TEST_RUN_ID,
      relativePath: 'dir/"><script>alert(2)</script>.txt',
      sha256: TEST_SHA256,
      byteSize: 100,
      contentType: 'text/plain"><img src=x onerror=alert(3)>',
      createdAt: "2026-11-08T12:00:00.000Z",
    };

    const html = renderArtifactViewer({
      artifacts: [dangerousArtifact],
      selectedArtifactId: '<svg onload="alert(1)">',
    });

    expect(html).not.toContain("<svg onload");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;svg onload=&quot;alert(1)&quot;&gt;");
  });
});

describe("Evidence Viewer Functional HTML Rendering", () => {
  it("renders authoritative VERIFIED_SUCCESS outcome", () => {
    const html = renderEvidenceViewer({
      finalOutcome: "VERIFIED_SUCCESS",
      isTerminal: true,
      completedVerifications: [
        {
          verifierId: "verifier-posix-cleanroom",
          specId: "spec-f2p-exit0",
          status: "VERIFIED",
          evidenceIds: ["ev-test-f2p-pass"],
          message: "All cleanroom test specifications passed successfully",
          verifiedAt: "2026-11-08T12:05:00.000Z",
        },
      ],
    });

    expect(html).toContain("verdict-banner-verified");
    expect(html).toContain("Independently Verified Task Completion");
    expect(html).toContain("verifier-posix-cleanroom");
    expect(html).toContain("spec-f2p-exit0");
    expect(html).toContain("VERIFIED");
    expect(html).toContain("ev-test-f2p-pass");
  });

  it("renders authoritative FALSE_COMPLETION with rejection checklist", () => {
    const rejections: VerificationRejectedView[] = [
      {
        status: "COMPLETION_REJECTED",
        reason: "UNVERIFIED_COMPLETION_CLAIM",
        message: "Agent claimed goal reached but unit test suite failed",
        requirements: { requiredSpec: "tests/parser.test.ts must exit 0" },
        outstandingRequirements: ["tests/parser.test.ts (exit code was 1)", "cleanroom diff verification"],
        rejectedAt: "2026-11-08T12:04:30.000Z",
      },
    ];

    const html = renderEvidenceViewer({
      finalOutcome: "FALSE_COMPLETION",
      isTerminal: true,
      rejections,
    });

    expect(html).toContain("verdict-banner-false-completion");
    expect(html).toContain("False Completion Claim Detected");
    expect(html).toContain("Outstanding Requirements");
    expect(html).toContain("tests/parser.test.ts (exit code was 1)");
    expect(html).toContain("cleanroom diff verification");
  });

  it("renders distinct provenance for INDEPENDENT_OBSERVER vs PROVIDER_REPORTED evidence", () => {
    const recordedEvidence: RecordedEvidenceView[] = [
      {
        evidenceId: "ev-observer-1",
        runId: TEST_RUN_ID,
        source: "INDEPENDENT_OBSERVER",
        kind: "process.exit_code",
        contentHash: "sha256-obs-1111",
        observedAt: "2026-11-08T12:03:00.000Z",
      },
      {
        evidenceId: "ev-selfclaim-2",
        runId: TEST_RUN_ID,
        source: "PROVIDER_REPORTED",
        kind: "agent.self_claim",
        contentHash: "sha256-self-2222",
        observedAt: "2026-11-08T12:03:05.000Z",
      },
    ];

    const html = renderEvidenceViewer({
      finalOutcome: null,
      isTerminal: false,
      recordedEvidence,
    });

    expect(html).toContain("Provenance: Independent Observer");
    expect(html).toContain("Provenance: Provider Reported");
    expect(html).toContain("badge-blue");
    expect(html).toContain("badge-gray");
    expect(html).not.toContain("badge-green");
    expect(html).toContain("ev-observer-1");
    expect(html).toContain("ev-selfclaim-2");
  });

  it("renders prominent warning for manual operator unverified completion override", () => {
    const unverifiedOverrides: UnverifiedCompletionAuthorizedView[] = [
      {
        authorizedAt: "2026-11-08T12:04:00.000Z",
        operatorNote: "Emergency maintenance bypass",
      },
    ];

    const html = renderEvidenceViewer({
      finalOutcome: "VERIFIED_SUCCESS",
      isTerminal: true,
      unverifiedOverrides,
    });

    expect(html).toContain("evidence-override-alert");
    expect(html).toContain("Operator Override Active");
    expect(html).toContain("does NOT represent objective verification of correctness");
  });

  it("always renders the fundamental invariant disclosure: artifact presence != verification success", () => {
    const html = renderEvidenceViewer({
      finalOutcome: "VERIFIED_SUCCESS",
      isTerminal: true,
    });

    expect(html).toContain("evidence-disclaimer-box");
    expect(html).toContain("Artifact creation does NOT prove task correctness");
    expect(html).toContain("only independent verification specifications evaluated by the verifier establish an authoritative verdict");
  });
});

describe("DashboardController Artifact & Evidence Lifecycle", () => {
  let mockApiClient: any;

  beforeEach(() => {
    mockApiClient = {
      getArtifacts: vi.fn(async (runId: string) => ({
        success: true,
        data: [
          {
            artifactId: `art-${runId}-1`,
            runId,
            relativePath: "patch.diff",
            sha256: TEST_SHA256,
            byteSize: 1024,
            contentType: "text/x-diff",
            createdAt: new Date().toISOString(),
          },
        ],
      })),
      getRun: vi.fn(async (runId: string) => ({
        success: true,
        data: {
          runId,
          taskId: "task-1",
          status: "COMPLETED",
          attemptNumber: 1,
          currentStepIndex: 3,
          leaseExpiresAt: null,
          finalOutcome: "VERIFIED_SUCCESS",
          metrics: { wallClockMs: 1500, stepCount: 3, toolCallCount: 2 },
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      })),
      openEventStream: vi.fn(() => ({
        connect: vi.fn(),
        abort: vi.fn(),
        isConnected: () => false,
        getStatus: () => "idle",
        getLastSequence: () => 0,
      })),
    };
  });

  it("automatically loads artifacts when a task with a runId is selected", async () => {
    const controller = new DashboardController(mockApiClient, {
      tasks: [
        {
          taskId: "task-1",
          title: "Test Task",
          status: "RUNNING",
          executionMode: "sandboxed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contractId: "contract-1",
          runId: "run-target-1",
        },
      ],
    });

    controller.selectTask("task-1");
    expect(controller.getState().artifactsLoading).toBe(true);

    // Await async artifact resolution
    await vi.waitFor(() => {
      expect(controller.getState().artifactsLoading).toBe(false);
    });

    expect(mockApiClient.getArtifacts).toHaveBeenCalledWith("run-target-1", expect.anything());
    expect(controller.getState().artifacts).toHaveLength(1);
    expect(controller.getState().artifacts![0]!.artifactId).toBe("art-run-target-1-1");
  });

  it("aborts active artifact request and resets state when switching to another task", async () => {
    let resolveFirstArtifacts!: (val: any) => void;
    const firstPromise = new Promise((res) => {
      resolveFirstArtifacts = res;
    });

    mockApiClient.getArtifacts = vi.fn((runId: string, _options: any) => {
      if (runId === "run-slow-1") {
        return firstPromise;
      }
      return Promise.resolve({
        success: true,
        data: [
          {
            artifactId: "art-fast-2",
            runId: "run-fast-2",
            relativePath: "report.json",
            sha256: TEST_SHA256,
            byteSize: 256,
            contentType: "application/json",
            createdAt: new Date().toISOString(),
          },
        ],
      });
    });

    const controller = new DashboardController(mockApiClient, {
      tasks: [
        {
          taskId: "task-slow",
          title: "Slow Task",
          status: "RUNNING",
          executionMode: "sandboxed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contractId: "c-1",
          runId: "run-slow-1",
        },
        {
          taskId: "task-fast",
          title: "Fast Task",
          status: "RUNNING",
          executionMode: "sandboxed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contractId: "c-2",
          runId: "run-fast-2",
        },
      ],
    });

    // 1. Select slow task
    controller.selectTask("task-slow");
    expect(controller.getState().selectedTaskId).toBe("task-slow");

    // 2. Immediately switch to fast task before slow resolves
    controller.selectTask("task-fast");
    expect(controller.getState().selectedTaskId).toBe("task-fast");

    await vi.waitFor(() => {
      expect(controller.getState().artifactsLoading).toBe(false);
    });

    expect(controller.getState().artifacts).toHaveLength(1);
    expect(controller.getState().artifacts![0]!.artifactId).toBe("art-fast-2");

    // 3. Now slow request finishes in background
    resolveFirstArtifacts({
      success: true,
      data: [{ artifactId: "art-stale-slow", runId: "run-slow-1" }],
    });

    // Stale slow response must NOT overwrite fast task's artifacts
    expect(controller.getState().artifacts![0]!.artifactId).toBe("art-fast-2");
  });

  it("handles artifact fetch errors gracefully without breaking controller", async () => {
    mockApiClient.getArtifacts = vi.fn(async () => {
      throw new Error("500 Internal Server Error");
    });

    const controller = new DashboardController(mockApiClient, {
      tasks: [
        {
          taskId: "task-err",
          title: "Error Task",
          status: "RUNNING",
          executionMode: "sandboxed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contractId: "c-err",
          runId: "run-err",
        },
      ],
    });

    controller.selectTask("task-err");

    await vi.waitFor(() => {
      expect(controller.getState().artifactsLoading).toBe(false);
    });

    expect(controller.getState().artifactsError).toBe("500 Internal Server Error");
    expect(controller.getState().artifacts).toHaveLength(0);
  });

  it("toggles artifact selection with selectArtifact", () => {
    const controller = new DashboardController(mockApiClient);
    expect(controller.getState().selectedArtifactId).toBeUndefined();

    controller.selectArtifact("art-target-123");
    expect(controller.getState().selectedArtifactId).toBe("art-target-123");

    controller.selectArtifact(undefined);
    expect(controller.getState().selectedArtifactId).toBeUndefined();
  });

  it("aggregates verification and evidence events from SSE stream", () => {
    let eventCallback: ((env: SseEventEnvelope) => void) | undefined;
    mockApiClient.openEventStream = vi.fn((_runId: string, options: any) => {
      eventCallback = options?.onEvent;
      return {
        connect: vi.fn(),
        abort: vi.fn(),
        isConnected: () => true,
        getStatus: () => "connected",
        getLastSequence: () => 1,
      };
    });

    const controller = new DashboardController(mockApiClient, {
      tasks: [
        {
          taskId: "task-sse",
          title: "SSE Task",
          status: "RUNNING",
          executionMode: "sandboxed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contractId: "c-sse",
          runId: "run-sse-1",
        },
      ],
    });

    controller.selectTask("task-sse");
    expect(eventCallback).toBeDefined();

    // 1. Emit evidence.recorded event
    eventCallback!({
      id: "evt-1",
      event: "evidence.recorded",
      runId: "run-sse-1",
      sequence: 1,
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
      producer: "cleanroom_runner",
      data: {
        evidenceId: "ev-test-1",
        source: "INDEPENDENT_OBSERVER",
        kind: "process.exit_code",
        contentHash: "hash-123",
      },
    });

    expect(controller.getState().recordedEvidence).toHaveLength(1);
    expect(controller.getState().recordedEvidence![0]!.evidenceId).toBe("ev-test-1");
    expect(controller.getState().recordedEvidence![0]!.source).toBe("INDEPENDENT_OBSERVER");

    // 2. Emit verification.completed event
    eventCallback!({
      id: "evt-2",
      event: "verification.completed",
      runId: "run-sse-1",
      sequence: 2,
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
      producer: "verifier",
      data: {
        verifierId: "cleanroom-verifier",
        specId: "spec-exit-0",
        status: "VERIFIED",
        evidenceIds: ["ev-test-1"],
        message: "Spec passed cleanly",
      },
    });

    expect(controller.getState().completedVerifications).toHaveLength(1);
    expect(controller.getState().completedVerifications![0]!.status).toBe("VERIFIED");
  });

  it("resets artifacts and evidence upon clearHistory()", () => {
    const controller = new DashboardController(mockApiClient, {
      artifacts: [
        {
          artifactId: "art-1",
          runId: "run-1",
          relativePath: "p.diff",
          sha256: TEST_SHA256,
          byteSize: 100,
          contentType: "text/x-diff",
          createdAt: new Date().toISOString(),
        },
      ],
      selectedArtifactId: "art-1",
      completedVerifications: [
        {
          verifierId: "v",
          specId: "s",
          status: "VERIFIED",
          evidenceIds: [],
          message: "ok",
          verifiedAt: new Date().toISOString(),
        },
      ],
    });

    expect(controller.getState().artifacts).toHaveLength(1);
    controller.clearHistory();

    expect(controller.getState().artifacts).toHaveLength(0);
    expect(controller.getState().selectedArtifactId).toBeUndefined();
    expect(controller.getState().completedVerifications).toHaveLength(0);
  });
});

describe("Fastify REST Artifact Transport Integration", () => {
  const TOK_TENANT_A = "a-operator-token-with-high-entropy-123456";
  const TOK_TENANT_B = "b-operator-token-with-high-entropy-654321";

  const principals = [
    {
      principalId: "p-a",
      token: TOK_TENANT_A,
      tenantId: "tenant-a",
      role: "operator" as const,
    },
    {
      principalId: "p-b",
      token: TOK_TENANT_B,
      tenantId: "tenant-b",
      role: "operator" as const,
    },
  ];

  it("GET /api/v1/runs/:runId/artifacts enforces Bearer authentication and tenant isolation", async () => {
    const runId = "run-seeded-art-1";
    const runsMap = new Map();
    runsMap.set(runId, {
      runId,
      taskId: "task-art-1",
      tenantId: "tenant-a",
      status: "COMPLETED",
      createdAt: new Date().toISOString(),
    });

    const seededArtifacts = new Map<string, any[]>([
      [
        runId,
        [
          {
            artifactId: "art-live-1",
            runId,
            relativePath: "exported/patch.diff",
            sha256: TEST_SHA256,
            byteSize: 1024,
            contentType: "text/x-diff",
            createdAt: new Date().toISOString(),
          },
        ],
      ],
    ]);

    const server = buildFastifyServer({
      principals,
      corsOrigins: [],
      inMemoryStore: {
        tasks: new Map(),
        runs: runsMap,
        artifacts: seededArtifacts,
      },
      env: {},
    });

    // 1. Unauthenticated request -> 401
    const unauthRes = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
    });
    expect(unauthRes.statusCode).toBe(401);

    // 2. Cross-tenant request (tenant-b querying tenant-a run) -> 404 (prevents enumeration)
    const crossTenantRes = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: {
        authorization: `Bearer ${TOK_TENANT_B}`,
      },
    });
    expect(crossTenantRes.statusCode).toBe(404);

    // 3. Authorized tenant request -> 200 with matching artifact list
    const authRes = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
      headers: {
        authorization: `Bearer ${TOK_TENANT_A}`,
      },
    });
    expect(authRes.statusCode).toBe(200);
    const body = authRes.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].artifactId).toBe("art-live-1");
    expect(body.data[0].sha256).toBe(TEST_SHA256);
  });
});
