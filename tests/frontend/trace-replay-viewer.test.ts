import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { EmeraldApiClient } from "../../apps/web/src/client/api-client.js";
import { DashboardController } from "../../apps/web/src/components/dashboard-controller.js";
import { renderDashboardHtml } from "../../apps/web/src/components/dashboard-view.js";
import {
  buildTraceReplayState,
  renderTraceReplayPanel,
} from "../../apps/web/src/components/trace-replay-viewer.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { TRACE_GUARDRAIL_RULES, type RunTrace } from "../../src/domain/index.js";
import { buildFastifyServer, type PrincipalRecord } from "../../src/transport/http/server.js";
import { generateSyntheticTraceFixtures } from "../fixtures/trace-fixtures.js";

function createServerFetch(server: FastifyInstance): typeof globalThis.fetch {
  return (async (input: unknown, init?: any): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : String(input);
    const parsed = new URL(urlStr);
    const reqPath = parsed.pathname + parsed.search;

    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (typeof (init.headers as Headers).forEach === "function") {
        (init.headers as Headers).forEach((v: string, k: string) => {
          headers[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          headers[k] = v;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    const injectRes = await server.inject({
      method: (init?.method as any) ?? "GET",
      url: reqPath,
      headers,
      payload: typeof init?.body === "string" ? init.body : undefined,
    });

    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(injectRes.headers)) {
      if (v !== undefined) {
        responseHeaders.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      }
    }

    return new Response(injectRes.body, {
      status: injectRes.statusCode,
      headers: responseHeaders,
    });
  }) as typeof globalThis.fetch;
}

describe("Idea 3 Phase 5 — Read-Only Trace Replay, Diff & Scorecard UI + GET API", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("1. Read-only views (trace list, trace detail, diff, scorecard)", () => {
    it("renders trace list with all 20 synthetic fixtures, status, and verdict (including COMPLETED_WITHOUT_VERDICT)", () => {
      const state = buildTraceReplayState();
      expect(state.traces).toHaveLength(20);
      expect(state.fixtureTraceCount).toBe(20);

      const html = renderTraceReplayPanel(state);
      expect(html).toContain('id="trace-replay-workbench"');
      expect(html).toContain('id="trace-list-panel"');
      expect(html).toContain("Total: 20");
      expect(html).toContain("trace-01-stub-success-echo");
      expect(html).toContain("trace-13-tool-output-poisoning-untrusted");
      expect(html).toContain("trace-15-secret-redaction-env-dump");
      expect(html).toContain("COMPLETED_WITHOUT_VERDICT");
      expect(html).toContain("Zero Live Model Calls");
    });

    it("renders trace detail with ordered spans and all 7 guardrail checks plus violations", () => {
      const state = buildTraceReplayState({
        selectedTraceId: "trace-13-tool-output-poisoning-untrusted",
      });
      const html = renderTraceReplayPanel(state);

      expect(html).toContain('id="trace-detail-panel"');
      expect(html).toContain('id="trace-span-timeline"');
      expect(html).toContain('data-span-id="span-13-tool-untrusted"');
      expect(html).toContain('data-span-id="span-13-tool-blocked"');
      expect(html).toContain("untrusted");
      expect(html).toContain("span-only");

      // All 7 guardrail rules appear in the detail panel
      for (const rule of TRACE_GUARDRAIL_RULES) {
        expect(html).toContain(`data-guardrail-rule="${rule}"`);
      }

      // Poisoning violations explicitly listed
      expect(html).toContain('id="trace-guardrail-violations"');
      expect(html).toContain('data-violation-rule="provenance"');
      expect(html).toContain("span-13-tool-blocked");
    });

    it("renders diff view showing changed span with exact changed fields, verdict transitions, and deltas", () => {
      const fixtures = generateSyntheticTraceFixtures();
      const fx02 = fixtures[1]!;
      const modified02: RunTrace = {
        ...fx02,
        traceId: "trace-02-modified-store",
        spans: fx02.spans.map((s) =>
          s.spanId === "span-02-llm-1"
            ? { ...s, status: "TIMED_OUT", costUsd: 0.04, latencyMs: 4500 }
            : s
        ),
      };

      const state = buildTraceReplayState({
        storeTraces: [modified02],
        diffOldTraceId: fx02.traceId,
        diffNewTraceId: modified02.traceId,
      });
      const html = renderTraceReplayPanel(state);

      expect(html).toContain('id="trace-diff-panel"');
      expect(html).toContain('id="trace-diff-spans"');
      expect(html).toContain('data-diff-span-id="span-02-llm-1"');
      expect(html).toContain('data-diff-change="changed"');
      expect(html).toContain("status, cost, latency");
      expect(html).toContain("Latency Delta (all-span-total)");
      expect(html).toContain("1500 ms");
    });

    it("renders scorecard counting all 20 fixtures with explicit latency scope label and delta", () => {
      const allSpanState = buildTraceReplayState({ latencyScope: "all-span-total" });
      const allSpanHtml = renderTraceReplayPanel(allSpanState);

      expect(allSpanHtml).toContain('id="trace-scorecard-panel"');
      expect(allSpanHtml).toContain('<strong id="scorecard-total-traces">20</strong>');
      expect(allSpanHtml).toContain(
        '<strong id="scorecard-completed-without-verdict">1</strong>'
      );
      expect(allSpanHtml).toContain("Latency Scope: all-span-total");
      expect(allSpanHtml).toContain("total=197648 ms");
      expect(allSpanHtml).toContain('id="scorecard-verdict-counts"');
      expect(allSpanHtml).toContain('id="scorecard-failure-taxonomy"');
      expect(allSpanHtml).toContain('id="scorecard-delta-panel"');
      expect(allSpanHtml.toLowerCase()).not.toContain("p-value");

      const llmOnlyState = buildTraceReplayState({ latencyScope: "llm-only" });
      const llmOnlyHtml = renderTraceReplayPanel(llmOnlyState);
      expect(llmOnlyHtml).toContain("Latency Scope: llm-only");
      expect(llmOnlyHtml).toContain("total=133000 ms");
      expect(llmOnlyHtml).not.toContain("Latency Scope: all-span-total (");

      // Also verify full dashboard renderer integrates the trace workbench and escapes XSS
      const leakyStoreTrace: RunTrace = {
        ...generateSyntheticTraceFixtures()[0]!,
        traceId: "trace-store-xss-test",
        runId: "run-xss-test",
        spans: [
          {
            ...generateSyntheticTraceFixtures()[0]!.spans[0]!,
            spanId: "span-xss-1",
            resultSummary: { note: "<script>alert(1)</script>" },
          },
        ],
      };
      const controller = new DashboardController(
        new EmeraldApiClient({ baseUrl: "http://127.0.0.1:3000" }),
        {
          traceReplay: buildTraceReplayState({
            storeTraces: [leakyStoreTrace],
            selectedTraceId: "trace-store-xss-test",
          }),
        }
      );
      const fullHtml = renderDashboardHtml(controller.getState());
      expect(fullHtml).toContain('id="trace-replay-workbench"');
      expect(fullHtml).not.toContain("<script>alert(1)</script>");
      expect(fullHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    });
  });

  describe("2. Controller scope switching and authenticated read-only Fastify GET integration", () => {
    it("serves tenant-scoped read-only GET /api/v1/traces* routes and updates DashboardController without mutating actions", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-ui-p5-"));
      tempDirs.push(tmpDir);
      const dbPath = path.join(tmpDir, "emerald.sqlite");
      const store = new SqliteStateStore({ location: dbPath });

      const TOK_ALPHA = "alpha-token-phase5-ui-test-1234";
      const TOK_BETA = "beta-token-phase5-ui-test-5678";
      const principals: PrincipalRecord[] = [
        { principalId: "op-alpha", tenantId: "tenant-alpha", role: "operator", token: TOK_ALPHA },
        { principalId: "op-beta", tenantId: "tenant-beta", role: "operator", token: TOK_BETA },
      ];

      const fixtures = generateSyntheticTraceFixtures();
      const traceAlpha1: RunTrace = {
        ...fixtures[1]!,
        traceId: "trace-alpha-stored-1",
        runId: "run-alpha-stored-1",
        tenantId: "tenant-alpha",
      };
      const traceAlpha2: RunTrace = {
        ...fixtures[5]!,
        traceId: "trace-alpha-stored-2",
        runId: "run-alpha-stored-2",
        tenantId: "tenant-alpha",
      };
      const traceBetaSecret: RunTrace = {
        ...fixtures[0]!,
        traceId: "trace-beta-stored-secret",
        runId: "run-beta-stored-secret",
        tenantId: "tenant-beta",
      };

      const traceStore = store.getTraceStore();
      traceStore.writeTrace(traceAlpha1, "2026-11-26T14:00:00.000Z");
      traceStore.writeTrace(traceAlpha2, "2026-11-26T14:01:00.000Z");
      traceStore.writeTrace(traceBetaSecret, "2026-11-26T14:02:00.000Z");

      const server = buildFastifyServer({ store, principals });
      try {
        // Auth & tenant enforcement
        const unauthRes = await server.inject({ method: "GET", url: "/api/v1/traces" });
        expect(unauthRes.statusCode).toBe(401);

        const forgedTenantRes = await server.inject({
          method: "GET",
          url: "/api/v1/traces?tenantId=tenant-beta",
          headers: { authorization: `Bearer ${TOK_ALPHA}` },
        });
        expect(forgedTenantRes.statusCode).toBe(400);

        const crossTenantDetail = await server.inject({
          method: "GET",
          url: "/api/v1/traces/trace-beta-stored-secret",
          headers: { authorization: `Bearer ${TOK_ALPHA}` },
        });
        expect(crossTenantDetail.statusCode).toBe(404);

        const postAttempt = await server.inject({
          method: "POST",
          url: "/api/v1/traces",
          headers: { authorization: `Bearer ${TOK_ALPHA}` },
          payload: {},
        });
        expect(postAttempt.statusCode).toBe(404);

        // Read-only detail, diff, scorecard on backend
        const detailRes = await server.inject({
          method: "GET",
          url: "/api/v1/traces/trace-alpha-stored-1",
          headers: { authorization: `Bearer ${TOK_ALPHA}` },
        });
        expect(detailRes.statusCode).toBe(200);
        const detailJson = detailRes.json() as any;
        expect(detailJson.data.trace.traceId).toBe("trace-alpha-stored-1");
        expect(detailJson.data.replayReport.checks).toHaveLength(7);

        const diffRes = await server.inject({
          method: "GET",
          url: "/api/v1/traces/diff?oldId=trace-alpha-stored-1&newId=trace-alpha-stored-2",
          headers: { authorization: `Bearer ${TOK_ALPHA}` },
        });
        expect(diffRes.statusCode).toBe(200);
        expect((diffRes.json() as any).data.traceDiff.isEmpty).toBe(false);

        const scorecardRes = await server.inject({
          method: "GET",
          url: "/api/v1/traces/scorecard",
          headers: { authorization: `Bearer ${TOK_ALPHA}` },
        });
        expect(scorecardRes.statusCode).toBe(200);
        expect((scorecardRes.json() as any).data.scorecard.totalTraces).toBe(2);
        expect((scorecardRes.json() as any).data.latencyScope).toBe("all-span-total");

        // Frontend EmeraldApiClient + DashboardController integration
        const client = new EmeraldApiClient({
          baseUrl: "http://127.0.0.1:3000",
          token: TOK_ALPHA,
          fetch: createServerFetch(server),
        });
        const controller = new DashboardController(client);
        await controller.refreshTracesFromStore();

        const replayState = controller.getState().traceReplay!;
        // 2 alpha store traces + 20 fixtures (beta trace never leaks!)
        expect(replayState.storeTraceCount).toBe(2);
        expect(replayState.traces).toHaveLength(22);
        expect(replayState.traces.some((t) => t.traceId === "trace-beta-stored-secret")).toBe(false);
        expect(replayState.scorecard.totalTraces).toBe(22);

        controller.selectTrace("trace-alpha-stored-1");
        expect(controller.getState().traceReplay?.selectedTraceId).toBe("trace-alpha-stored-1");

        controller.setScorecardLatencyScope("llm-only");
        expect(controller.getState().traceReplay?.scorecardLatencyScope).toBe("llm-only");
      } finally {
        await server.close();
        store.close();
      }
    });
  });
});
