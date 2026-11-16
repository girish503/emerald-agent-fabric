/**
 * Emerald Agent Fabric — Real-Time DAG SSE Stream Client
 *
 * Consumes the live DAG execution stream from /api/runs/:runId/dag (or /api/dag).
 * Streams real-time DAG node states, timings, tool calls, verifications, and approvals.
 */

import type { RunDagSnapshot } from "../types/api.js";

export interface DagSseClientOptions {
  readonly baseUrl: string;
  readonly runId?: string;
  readonly getToken?: () => Promise<string | null | undefined> | string | null | undefined;
  readonly onSnapshot: (snapshot: RunDagSnapshot) => void;
  readonly onError?: (error: Error) => void;
  readonly onStatusChange?: (status: "connecting" | "connected" | "reconnecting" | "closed") => void;
  readonly pollIntervalMs?: number;
}

export class DagSseClient {
  private isClosed = false;
  private abortController: AbortController | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: DagSseClientOptions) {}

  public start(): void {
    if (this.isClosed) return;
    this.connectStream().catch(() => {
      if (!this.isClosed) {
        this.startPollingFallback();
      }
    });
  }

  public close(): void {
    this.isClosed = true;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.options.onStatusChange?.("closed");
  }

  private async connectStream(): Promise<void> {
    if (this.isClosed) return;
    this.options.onStatusChange?.("connecting");

    const endpoint = this.options.runId
      ? `/api/runs/${encodeURIComponent(this.options.runId)}/dag?stream=true`
      : `/api/dag?stream=true`;
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}${endpoint}`;

    this.abortController = new AbortController();
    const token = this.options.getToken ? await this.options.getToken() : null;

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        signal: this.abortController.signal,
      });
    } catch (err: any) {
      if (this.isClosed) return;
      this.options.onError?.(err);
      this.startPollingFallback();
      return;
    }

    if (!response.ok || !response.body) {
      this.startPollingFallback();
      return;
    }

    this.options.onStatusChange?.("connected");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this.isClosed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const block of parts) {
          const lines = block.split(/\r?\n/);
          let eventType = "message";
          let data = "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              data += (data ? "\n" : "") + line.slice(5).trim();
            }
          }

          if ((eventType === "dag_state" || eventType === "dag_update") && data) {
            try {
              const snapshot = JSON.parse(data) as RunDagSnapshot;
              this.options.onSnapshot(snapshot);
            } catch {
              // non-fatal parse failure
            }
          }
        }
      }
    } catch (err: any) {
      if (!this.isClosed) {
        this.options.onError?.(err);
        this.startPollingFallback();
      }
    }
  }

  private startPollingFallback(): void {
    if (this.isClosed || this.pollTimer) return;
    this.options.onStatusChange?.("connected");

    const poll = async () => {
      if (this.isClosed) return;
      try {
        const endpoint = this.options.runId
          ? `/api/runs/${encodeURIComponent(this.options.runId)}/dag`
          : `/api/dag`;
        const url = `${this.options.baseUrl.replace(/\/+$/, "")}${endpoint}`;
        const token = this.options.getToken ? await this.options.getToken() : null;

        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (res.ok) {
          const json = (await res.json()) as any;
          const snapshot = (json.data || json) as RunDagSnapshot;
          if (snapshot && Array.isArray(snapshot.nodes)) {
            this.options.onSnapshot(snapshot);
          }
        }
      } catch {
        // non-fatal in poll loop
      }
    };

    void poll();
    this.pollTimer = setInterval(poll, this.options.pollIntervalMs ?? 1000);
  }
}
