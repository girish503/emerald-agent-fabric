import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { QuiescenceResult, TenantQuiescencePort } from "../../ports/tenant-quiescence.port.js";

const execFileAsync = promisify(execFile);

/**
 * Well-known Docker labels attached to Emerald-managed tenant containers (ADR-0037).
 */
export const DOCKER_TENANT_LABELS = {
  RUN_ID: "emerald.run",
  ATTEMPT: "emerald.attempt",
  LEASE_ID: "emerald.lease",
  WORKER_ID: "emerald.worker",
} as const;

/**
 * Signature for subprocess runner, allowing deterministic fake injection in unit tests.
 */
export type SubprocessRunner = (
  file: string,
  args: readonly string[],
  options?: { timeoutMs?: number }
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface DockerTenantQuiescenceConfig {
  /** Path or binary name for the docker CLI. Default: "docker" */
  readonly dockerBinary?: string;
  /** Timeout in milliseconds for each subprocess execution. Default: 10_000 (10s) */
  readonly timeoutMs?: number;
  /** Optional custom runner for dependency injection / testing without real Docker daemon */
  readonly runner?: SubprocessRunner;
}

/**
 * DockerTenantQuiescenceAdapter (ADR-0037).
 *
 * Implements tenant discovery and verified termination using Docker labels:
 * 1. Query: lists containers with label `emerald.run=<runId>`.
 * 2. Terminate: stops (`docker kill`) any running containers, then removes (`docker rm -f`) all discovered containers.
 * 3. Verify: queries containers with label `emerald.run=<runId>` a second time.
 * 4. Verdict:
 *    - Returns QUIESCENT only when the second listing is positively verified to be empty.
 *    - Returns UNVERIFIED on command failure, timeout, non-zero exit, daemon error, malformed output,
 *      or surviving containers.
 *
 * Late-Start Race Limitation (ADR-0037 Section 4.6):
 * Two listings and verification do not eliminate every possible late-start race: a stale, lease-starved
 * worker that passed its lease check just before expiry could theoretically invoke `docker run`
 * immediately after recovery's second listing. Recovery relies on lease fencing, worker lease checks
 * before container creation, and `--workers-stopped` operator coordination.
 */
export class DockerTenantQuiescenceAdapter implements TenantQuiescencePort {
  readonly dockerBinary: string;
  readonly timeoutMs: number;
  private readonly runner: SubprocessRunner;

  constructor(config: DockerTenantQuiescenceConfig = {}) {
    this.dockerBinary = config.dockerBinary ?? "docker";
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.runner = config.runner ?? this.defaultRunner.bind(this);
  }

  private async defaultRunner(
    file: string,
    args: readonly string[],
    options?: { timeoutMs?: number }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const timeout = options?.timeoutMs ?? this.timeoutMs;
    try {
      const { stdout, stderr } = await execFileAsync(file, args as string[], {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
    } catch (err: unknown) {
      if (err && typeof err === "object") {
        const anyErr = err as {
          code?: number | string;
          exitCode?: number;
          killed?: boolean;
          signal?: string;
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          message?: string;
        };
        if (
          anyErr.killed ||
          anyErr.signal === "SIGTERM" ||
          anyErr.code === "ETIMEDOUT" ||
          anyErr.code === "ERR_CHILD_PROCESS_TIMEOUT"
        ) {
          throw new Error(`Subprocess timed out after ${timeout}ms`);
        }
        if (typeof anyErr.code === "number" || typeof anyErr.exitCode === "number") {
          return {
            exitCode: (anyErr.exitCode ?? anyErr.code) as number,
            stdout: String(anyErr.stdout ?? ""),
            stderr: String(anyErr.stderr ?? ""),
          };
        }
      }
      throw err;
    }
  }

  async quiesceRun(runId: string): Promise<QuiescenceResult> {
    if (!runId || typeof runId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
      return {
        status: "UNVERIFIED",
        reason: `Invalid runId format: '${runId}'`,
      };
    }

    try {
      // 1. Initial discovery listing
      const firstListing = await this.listContainersForRun(runId);
      if (firstListing.error) {
        return { status: "UNVERIFIED", reason: firstListing.error };
      }

      if (firstListing.containers.length === 0) {
        return { status: "QUIESCENT", stopped: 0 };
      }

      // 2. Terminate discovered containers
      const runningIds = firstListing.containers
        .filter((c) => c.state === "running")
        .map((c) => c.id);
      const allIds = firstListing.containers.map((c) => c.id);

      if (runningIds.length > 0) {
        const killResult = await this.killContainers(runningIds);
        if (killResult.error && killResult.error.includes("timed out")) {
          return { status: "UNVERIFIED", reason: killResult.error };
        }
      }

      const rmResult = await this.removeContainers(allIds);
      if (rmResult.error) {
        return { status: "UNVERIFIED", reason: rmResult.error };
      }

      // 3. Verification listing: must be strictly empty
      const secondListing = await this.listContainersForRun(runId);
      if (secondListing.error) {
        return {
          status: "UNVERIFIED",
          reason: `Verification listing failed: ${secondListing.error}`,
        };
      }

      if (secondListing.containers.length > 0) {
        const surviving = secondListing.containers.map((c) => c.id).join(", ");
        return {
          status: "UNVERIFIED",
          reason: `Containers remain after cleanup: ${surviving}`,
        };
      }

      return { status: "QUIESCENT", stopped: allIds.length };
    } catch (err: unknown) {
      return {
        status: "UNVERIFIED",
        reason: `Docker quiescence operation threw unexpected error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  private async listContainersForRun(
    runId: string
  ): Promise<{ containers: Array<{ id: string; state?: string }>; error?: string }> {
    const args = [
      "ps",
      "-a",
      "--filter",
      `label=${DOCKER_TENANT_LABELS.RUN_ID}=${runId}`,
      "--format",
      "{{.ID}} {{.State}}",
    ];

    let res: { exitCode: number; stdout: string; stderr: string };
    try {
      res = await this.runner(this.dockerBinary, args, { timeoutMs: this.timeoutMs });
    } catch (err: unknown) {
      return {
        containers: [],
        error: `Docker execution error during listing: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    if (res.exitCode !== 0) {
      return {
        containers: [],
        error: `Docker ps exited with code ${res.exitCode}: ${
          res.stderr.trim() || res.stdout.trim() || "unknown error"
        }`,
      };
    }

    const lines = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const containers: Array<{ id: string; state?: string }> = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length > 2 || parts.length === 0) {
        return {
          containers: [],
          error: `Malformed output from docker ps: '${line}'`,
        };
      }
      const id = parts[0];
      if (!id || !/^[a-zA-Z0-9_.-]{4,64}$/.test(id)) {
        return {
          containers: [],
          error: `Malformed container ID in docker ps output: '${id ?? ""}'`,
        };
      }
      const part1 = parts[1];
      const state = parts.length === 2 && part1 !== undefined ? part1.toLowerCase() : undefined;
      containers.push({ id, state });
    }

    return { containers };
  }

  private async killContainers(ids: string[]): Promise<{ error?: string }> {
    const args = ["kill", ...ids];
    try {
      await this.runner(this.dockerBinary, args, { timeoutMs: this.timeoutMs });
      return {};
    } catch (err: unknown) {
      return {
        error: `Docker kill failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async removeContainers(ids: string[]): Promise<{ error?: string }> {
    const args = ["rm", "-f", ...ids];
    try {
      const res = await this.runner(this.dockerBinary, args, { timeoutMs: this.timeoutMs });
      if (res.exitCode !== 0) {
        return {
          error: `Docker rm exited with code ${res.exitCode}: ${
            res.stderr.trim() || res.stdout.trim() || "unknown error"
          }`,
        };
      }
      return {};
    } catch (err: unknown) {
      return {
        error: `Docker rm failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
