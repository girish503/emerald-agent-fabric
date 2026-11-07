import { execFile, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { RunCommandOutput } from "../../domain/tool-schemas.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../ports/execution-provider.port.js";
import type { TenantQuiescencePort } from "../../ports/tenant-quiescence.port.js";
import {
  DockerTenantQuiescenceAdapter,
  DOCKER_TENANT_LABELS,
  type SubprocessRunner,
} from "./docker-tenant-quiescence-adapter.js";

export interface RunCommandExecutionPayload {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly maxOutputBytes?: number;
}

const execFileAsync = promisify(execFile);

export interface DaemonSecurityInspection {
  readonly available: boolean;
  readonly isRootlessDaemon: boolean;
  readonly securityOptions: readonly string[];
  readonly serverVersion?: string;
  readonly dockerRootDir?: string;
  readonly rawInspection?: string;
  readonly error?: string;
}

export interface DockerExecutionConfig {
  readonly image?: string; // Default: "node:22-alpine"
  readonly memoryLimit?: string; // Default: "256m"
  readonly cpuLimit?: string; // Default: "0.5"
  readonly pidsLimit?: number; // Default: 64
  readonly tmpfsSize?: string; // Default: "64m"
  readonly maxOutputBytes?: number; // Default: 1024 * 1024 (1 MB)
  readonly networkDisabled?: boolean; // Default: true (--network=none)
  readonly readOnlyRootfs?: boolean; // Default: true (--read-only)
  readonly runAsUser?: string; // Default: "1000:1000" (non-root rootless boundary)
  readonly dockerBinary?: string; // Default: "docker"
  readonly quiescence?: TenantQuiescencePort;
  /** Graceful `docker stop -t` window in seconds before escalating to `docker kill`. Default: 2 */
  readonly stopGraceSeconds?: number;
  /** Upper bound for each termination subprocess and for the local CLI to exit. Default: 10_000 */
  readonly terminationTimeoutMs?: number;
  /** If true, requires the Docker daemon itself to run in rootless mode (verified via daemon SecurityOptions). Default: false */
  readonly requireRootlessDaemon?: boolean;
  /** Explicit image allowlist. If non-empty, container image must be present in this list. */
  readonly imageAllowlist?: readonly string[];
  /** Test seam: spawns the long-running `docker run` CLI. Default: node:child_process spawn. */
  readonly spawnProcess?: DockerSpawn;
  /** Test seam: runs short bounded docker commands (stop/kill/rm). Default: node:child_process execFile. */
  readonly commandRunner?: SubprocessRunner;
}

/** Minimal child-process surface the provider relies on (satisfied by node:child_process ChildProcess). */
export interface DockerChildProcess {
  readonly stdin: { write(chunk: string): unknown; end(): unknown; on(event: "error", l: (e: Error) => void): unknown };
  readonly stdout: { on(event: "data", l: (chunk: Buffer) => void): unknown };
  readonly stderr: { on(event: "data", l: (chunk: Buffer) => void): unknown };
  on(event: "error", l: (e: Error) => void): unknown;
  on(event: "close", l: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type DockerSpawn = (file: string, args: readonly string[]) => DockerChildProcess;

const defaultSpawn: DockerSpawn = (file, args) =>
  spawn(file, args as string[], { stdio: ["pipe", "pipe", "pipe"] }) as unknown as DockerChildProcess;

/** Bounded command runner: non-zero exits resolve; spawn failures and timeouts reject. */
function createDefaultCommandRunner(): SubprocessRunner {
  return async (file, args, options) => {
    const timeout = options?.timeoutMs ?? 10_000;
    try {
      const { stdout, stderr } = await execFileAsync(file, args as string[], { timeout, maxBuffer: 10 * 1024 * 1024 });
      return { exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
    } catch (err: unknown) {
      const e = err as { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string } | null;
      if (e && (e.killed || e.signal === "SIGTERM")) throw new Error(`Subprocess timed out after ${timeout}ms`);
      if (e && typeof e.code === "number") {
        return { exitCode: e.code, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
      }
      throw err;
    }
  };
}

/** Outcome of the single-flight stop/escalate/verify sequence. */
interface TerminationOutcome {
  readonly verified: boolean;
  readonly reason: string;
  readonly stages: readonly string[];
}

function isDaemonErrorText(text: string): boolean {
  return (
    text.includes("Cannot connect to the Docker daemon") ||
    text.includes("daemon is not running") ||
    text.includes("dockerDesktopLinuxEngine") ||
    text.includes("error during connect") ||
    text.includes("Is the docker daemon running") ||
    text.includes("docker API")
  );
}

/**
 * Deterministic in-container runner script.
 * Fixed implementation authored by the provider. Reads input strictly from stdin.
 */
const IN_CONTAINER_RUNNER_SCRIPT = `
const op = process.argv[1];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = input ? JSON.parse(input) : null;
    let result;
    if (op === 'echo') {
      result = payload;
    } else if (op === 'sum') {
      if (!Array.isArray(payload)) throw new Error('Input for sum must be an array of numbers');
      result = payload.reduce((a, b) => a + b, 0);
    } else if (op === 'fail') {
      throw new Error('Deterministic computation failure in container');
    } else if (op === 'slow') {
      setInterval(() => {}, 1000);
      return;
    } else if (op === 'output-flood') {
      for (let i = 0; i < 20000; i++) {
        process.stdout.write('X'.repeat(100));
      }
      return;
    } else if (op === 'workspace-write') {
      const fs = require('fs');
      const p = require('path');
      const filename = (payload && payload.filename) || 'test.txt';
      const content = (payload && payload.content !== undefined) ? payload.content : 'hello workspace';
      const targetPath = p.join('/workspace', filename);
      fs.writeFileSync(targetPath, content, 'utf8');
      result = { written: true, path: '/workspace/' + filename, content };
    } else if (op === 'workspace-read') {
      const fs = require('fs');
      const p = require('path');
      const filename = (payload && payload.filename) || 'test.txt';
      const targetPath = p.join('/workspace', filename);
      const content = fs.readFileSync(targetPath, 'utf8');
      result = { content, path: '/workspace/' + filename };
    } else if (op === 'workspace-assert-confinement') {
      const fs = require('fs');
      let rootWritable = false;
      try {
        fs.writeFileSync('/root_probe.txt', 'fail');
        rootWritable = true;
      } catch (e) {
        rootWritable = false;
      }
      const hasDockerSock = fs.existsSync('/var/run/docker.sock');
      const workspaceExists = fs.existsSync('/workspace');
      result = { rootWritable, hasDockerSock, workspaceExists };
    } else {
      throw new Error('Unsupported operation: ' + op);
    }
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    process.stderr.write(err.message || String(err));
    process.exit(1);
  }
});
`.trim();

const SUPPORTED_OPERATIONS = new Set([
  "echo",
  "sum",
  "fail",
  "slow",
  "output-flood",
  "workspace-write",
  "workspace-read",
  "workspace-assert-confinement",
  "run_command",
]);

/**
 * DockerExecutionProvider executes deterministic operations within an isolated,
 * ephemeral OCI/Docker container with strict resource, filesystem, and network constraints.
 *
 * Security & Boundary Controls:
 * - Mechanical Operation Routing: Maps operationName to a fixed provider-controlled script.
 *   Does NOT allow arbitrary shell command execution.
 * - Network Policy: Docker `--network=none` is configured. Normal container network connectivity
 *   is therefore disabled. Platform/daemon assumptions remain part of the threat model.
 *   Container isolation is defense-in-depth, not an absolute security boundary.
 * - Filesystem Boundary: The container is isolated from host filesystem mounts, uses a read-only
 *   container root filesystem (--read-only), and has only explicitly controlled temporary writable
 *   storage (--tmpfs /tmp:rw,noexec,nosuid,size=64m). This significantly reduces the blast radius
 *   of filesystem mutation and untrusted execution relative to in-process execution, but does not
 *   represent an absolute filesystem security boundary.
 * - Resource Caps: Explicit memory (--memory=256m), CPU (--cpus=0.5), and PID (--pids-limit=64) limits.
 * - Capability Dropping: All Linux capabilities dropped (--cap-drop=ALL, no-new-privileges).
 * - Termination & Cleanup: Distinguishes logical timeout from physical container termination.
 *   Attempts physical container kill on timeout; unconditionally cleans up container on exit.
 * - Unbounded Output Defense: Caps stdout/stderr accumulation at maxOutputBytes (1 MB).
 * - Fail-Closed Execution Policy: For untrusted operations where container isolation is required,
 *   if Docker is unavailable, the caller/system must fail closed (FAIL CLOSED). In-process execution
 *   must NOT be used as an automatic fallback for untrusted operations. In-process execution remains
 *   available solely for explicitly trusted deterministic operations.
 */
export class DockerExecutionProvider implements ExecutionProvider {
  readonly name = "docker";
  /**
   * Containers outlive a dead worker (ADR-0037). Quiescence verification is provided by DockerTenantQuiescenceAdapter.
   */
  readonly tenantModel = "ISOLATED_PROCESSES" as const;
  readonly quiescence: TenantQuiescencePort;
  /**
   * Cancellation/timeout are honoured through a bounded stop -> kill -> verify lifecycle and are reported as
   * CANCELLED/TIMED_OUT only after the quiescence port returns QUIESCENT; otherwise FAILED/TERMINATION_UNVERIFIED.
   * Kept at COOPERATIVE (not PHYSICAL) until that guarantee is proven by an authorized live Docker rehearsal.
   */
  readonly cancellationModel = "COOPERATIVE" as const;
  private readonly spawnProcess: DockerSpawn;
  private readonly commandRunner: SubprocessRunner;
  readonly config: Required<
    Omit<DockerExecutionConfig, "quiescence" | "spawnProcess" | "commandRunner">
  >;

  /**
   * Validates container user configuration. UID 0 / root execution is strictly forbidden.
   */
  static validateRunAsUser(user: string): void {
    if (!user || typeof user !== "string" || user.trim().length === 0) {
      throw new Error("Invalid runAsUser: user string must not be empty");
    }
    const trimmed = user.trim().toLowerCase();
    if (trimmed === "0" || trimmed === "root" || trimmed.startsWith("0:") || trimmed.startsWith("root:")) {
      throw new Error(`Security violation: Root container execution (UID 0 / root) is strictly forbidden (got '${user}')`);
    }
    const parts = trimmed.split(":");
    const firstPart = parts[0] ?? "";
    const uid = Number.parseInt(firstPart, 10);
    if (Number.isNaN(uid) || uid === 0 || uid < 0) {
      throw new Error(`Security violation: Invalid or root UID (got '${firstPart}' in '${user}')`);
    }
  }

  /**
   * Pre-validates resource and timeout boundaries at construction.
   */
  private static validateResourceLimits(config: DockerExecutionConfig): void {
    if (config.pidsLimit !== undefined) {
      if (!Number.isInteger(config.pidsLimit) || config.pidsLimit <= 0) {
        throw new Error(`Invalid pidsLimit: must be a positive integer (got ${config.pidsLimit})`);
      }
    }
    if (config.maxOutputBytes !== undefined) {
      if (!Number.isInteger(config.maxOutputBytes) || config.maxOutputBytes <= 0) {
        throw new Error(`Invalid maxOutputBytes: must be a positive integer (got ${config.maxOutputBytes})`);
      }
    }
    if (config.cpuLimit !== undefined) {
      const cpu = Number.parseFloat(config.cpuLimit);
      if (Number.isNaN(cpu) || cpu <= 0) {
        throw new Error(`Invalid cpuLimit: must be a positive number (got '${config.cpuLimit}')`);
      }
    }
    if (config.stopGraceSeconds !== undefined && config.stopGraceSeconds < 0) {
      throw new Error(`Invalid stopGraceSeconds: must be non-negative (got ${config.stopGraceSeconds})`);
    }
    if (config.terminationTimeoutMs !== undefined && config.terminationTimeoutMs <= 0) {
      throw new Error(`Invalid terminationTimeoutMs: must be positive (got ${config.terminationTimeoutMs})`);
    }
  }

  /**
   * Independently inspects and evaluates the Docker daemon's security configuration,
   * specifically detecting whether the daemon is running in rootless mode vs rootful mode.
   * Note: This inspects the daemon host configuration, which is distinct from the container user (runAsUser).
   */
  static async inspectDaemonSecurity(
    dockerBinary: string = "docker",
    runner?: SubprocessRunner
  ): Promise<DaemonSecurityInspection> {
    try {
      const run = runner ?? createDefaultCommandRunner();
      const res = await run(
        dockerBinary,
        ["info", "--format", "{{json .SecurityOptions}}|{{.ServerVersion}}|{{.DockerRootDir}}"],
        { timeoutMs: 10_000 }
      );
      if (res.exitCode !== 0) {
        return {
          available: false,
          isRootlessDaemon: false,
          securityOptions: [],
          error: res.stderr.trim() || `docker info exited with code ${res.exitCode}`,
        };
      }
      const raw = res.stdout.trim();
      const parts = raw.split("|");
      const secOptRaw = parts[0] || "[]";
      const serverVersion = parts[1] || undefined;
      const dockerRootDir = parts[2] || undefined;

      let securityOptions: string[] = [];
      try {
        const parsed = JSON.parse(secOptRaw);
        if (Array.isArray(parsed)) {
          securityOptions = parsed.map((item) => String(item));
        } else if (typeof parsed === "string") {
          securityOptions = [parsed];
        }
      } catch {
        if (secOptRaw && secOptRaw !== "<no value>") {
          securityOptions = secOptRaw.split(",").map((s) => s.trim());
        }
      }

      const isRootlessDaemon = securityOptions.some((opt) =>
        opt.toLowerCase().includes("rootless")
      );

      return {
        available: true,
        isRootlessDaemon,
        securityOptions,
        serverVersion,
        dockerRootDir,
        rawInspection: raw,
      };
    } catch (err: unknown) {
      return {
        available: false,
        isRootlessDaemon: false,
        securityOptions: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  constructor(config: DockerExecutionConfig = {}) {
    if (config.networkDisabled === false) {
      throw new Error(
        "Network access is not available: Phase 3 enforces network = NONE without explicit governance capability architecture."
      );
    }

    const runAsUser = config.runAsUser ?? "1000:1000";
    DockerExecutionProvider.validateRunAsUser(runAsUser);
    DockerExecutionProvider.validateResourceLimits(config);

    this.config = {
      image: config.image ?? "node:22-alpine",
      memoryLimit: config.memoryLimit ?? "256m",
      cpuLimit: config.cpuLimit ?? "0.5",
      pidsLimit: config.pidsLimit ?? 64,
      tmpfsSize: config.tmpfsSize ?? "64m",
      maxOutputBytes: config.maxOutputBytes ?? 1024 * 1024,
      networkDisabled: true,
      readOnlyRootfs: config.readOnlyRootfs ?? true,
      runAsUser,
      dockerBinary: config.dockerBinary ?? "docker",
      stopGraceSeconds: config.stopGraceSeconds ?? 2,
      terminationTimeoutMs: config.terminationTimeoutMs ?? 25_000,
      requireRootlessDaemon: config.requireRootlessDaemon ?? false,
      imageAllowlist: config.imageAllowlist ? [...config.imageAllowlist] : ["node:22-alpine", "alpine:latest"],
    };
    this.spawnProcess = config.spawnProcess ?? defaultSpawn;
    this.commandRunner = config.commandRunner ?? createDefaultCommandRunner();

    this.quiescence =
      config.quiescence ??
      new DockerTenantQuiescenceAdapter({
        dockerBinary: this.config.dockerBinary,
        runner: this.commandRunner,
      });
  }

  /**
   * Probes if the Docker daemon and CLI are functional and available.
   */
  static async isAvailable(
    dockerBinary: string = "docker"
  ): Promise<{ available: boolean; version?: string; error?: string }> {
    try {
      const { stdout } = await execFileAsync(dockerBinary, ["version", "--format", "{{.Client.Version}}"]);
      // Also verify server connectivity
      await execFileAsync(dockerBinary, ["info", "--format", "{{.ServerVersion}}"]);
      return { available: true, version: stdout.trim() };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, error: msg };
    }
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    const startTime = performance.now();

    // 0. Workload trust classification & tenant validation (Workstreams 1 & 3)
    if (request.trustClassification === "UNKNOWN") {
      return {
        status: "FAILED",
        error: {
          code: "UNKNOWN_TRUST_CLASSIFICATION",
          message: "Execution rejected: Workload trust classification is UNKNOWN (FAIL CLOSED per security constitution).",
        },
        durationMs: Math.round(performance.now() - startTime),
        providerMetadata: { provider: this.name, operation: request.operationName },
      };
    }

    if (
      request.trustClassification === "MULTI_TENANT_WORKLOAD" &&
      (!request.tenantId || typeof request.tenantId !== "string" || request.tenantId.trim().length === 0)
    ) {
      return {
        status: "FAILED",
        error: {
          code: "SANDBOX_CONFIGURATION_INVALID",
          message: "Execution rejected: MULTI_TENANT_WORKLOAD requires an explicit non-empty tenantId.",
        },
        durationMs: Math.round(performance.now() - startTime),
        providerMetadata: { provider: this.name, operation: request.operationName },
      };
    }

    // Workstream 2: Mandatory rootless daemon enforcement
    const mustEnforceRootless =
      this.config.requireRootlessDaemon ||
      request.trustClassification === "UNTRUSTED_WORKLOAD" ||
      request.trustClassification === "ADVERSARIAL_WORKLOAD" ||
      request.trustClassification === "MULTI_TENANT_WORKLOAD";

    if (mustEnforceRootless) {
      const inspection = await DockerExecutionProvider.inspectDaemonSecurity(
        this.config.dockerBinary,
        this.commandRunner
      );
      if (!inspection.available) {
        return {
          status: "FAILED",
          error: {
            code: "DOCKER_UNAVAILABLE",
            message: `Docker daemon unavailable for rootless validation: ${inspection.error ?? "unknown error"}`,
          },
          durationMs: Math.round(performance.now() - startTime),
          providerMetadata: {
            provider: this.name,
            operation: request.operationName,
            rootlessValidation: "FAILED_DAEMON_UNAVAILABLE",
          },
        };
      }
      if (!inspection.isRootlessDaemon) {
        return {
          status: "FAILED",
          error: {
            code: "ROOTLESS_VALIDATION_FAILED",
            message: `Rootless Docker daemon is required by policy, but daemon is running in rootful mode (SecurityOptions: [${inspection.securityOptions.join(", ")}])`,
          },
          durationMs: Math.round(performance.now() - startTime),
          providerMetadata: {
            provider: this.name,
            operation: request.operationName,
            rootlessValidation: "REJECTED_ROOTFUL_DAEMON",
            securityOptions: inspection.securityOptions,
          },
        };
      }
    }

    if (this.config.imageAllowlist && this.config.imageAllowlist.length > 0) {
      if (!this.config.imageAllowlist.includes(this.config.image)) {
        return {
          status: "FAILED",
          error: {
            code: "IMAGE_POLICY_REJECTED",
            message: `Image '${this.config.image}' is not permitted by image allowlist: [${this.config.imageAllowlist.join(", ")}]`,
          },
          durationMs: Math.round(performance.now() - startTime),
          providerMetadata: {
            provider: this.name,
            operation: request.operationName,
            imageRejected: this.config.image,
            imageAllowlist: this.config.imageAllowlist,
          },
        };
      }
    }

    // 1. Mechanical operation routing check
    if (!SUPPORTED_OPERATIONS.has(request.operationName)) {
      return {
        status: "FAILED",
        error: {
          code: "OPERATION_NOT_FOUND",
          message: `Operation '${request.operationName}' not found in Docker execution registry`,
        },
        durationMs: Math.round(performance.now() - startTime),
        providerMetadata: { provider: this.name, operation: request.operationName },
      };
    }

    const isRunCommand = request.operationName === "run_command";
    const runCommandPayload = isRunCommand
      ? (request.inputPayload as RunCommandExecutionPayload | undefined)
      : undefined;

    // 2. Validate input payload
    let inputJson = "";
    if (isRunCommand) {
      if (
        !runCommandPayload ||
        !Array.isArray(runCommandPayload.argv) ||
        runCommandPayload.argv.length === 0 ||
        typeof runCommandPayload.argv[0] !== "string" ||
        runCommandPayload.argv[0].trim().length === 0
      ) {
        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: "Invalid run_command payload: argv must be a non-empty array of strings with non-empty argv[0]",
          },
          durationMs: Math.round(performance.now() - startTime),
          providerMetadata: { provider: this.name, operation: request.operationName },
        };
      }
    } else {
      try {
        inputJson = JSON.stringify(request.inputPayload ?? null);
      } catch (err: unknown) {
        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: `Failed to serialize input payload: ${err instanceof Error ? err.message : String(err)}`,
          },
          durationMs: Math.round(performance.now() - startTime),
          providerMetadata: { provider: this.name, operation: request.operationName },
        };
      }
    }

    // 3. Ephemeral container identity
    const containerId = crypto.randomUUID().slice(0, 12);
    const containerName = `emerald-run-${containerId}`;

    // Validate workspace mount if present
    if (request.workspace) {
      try {
        this.validateWorkspaceMount(
          request.workspace.hostPath,
          request.tenantId,
          request.trustClassification === "MULTI_TENANT_WORKLOAD"
        );
      } catch (err: unknown) {
        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: err instanceof Error ? err.message : String(err),
          },
          durationMs: Math.round(performance.now() - startTime),
          providerMetadata: {
            provider: this.name,
            operation: request.operationName,
            workspaceMountFailure: true,
          },
        };
      }
    }

    const containerMountPath = request.workspace?.containerMountPath ?? "/workspace";
    if (containerMountPath !== "/workspace" && !containerMountPath.startsWith("/workspace/")) {
      return {
        status: "FAILED",
        error: {
          code: "EXECUTION_FAILED",
          message: "Security violation: Container mount path must be /workspace or a subpath of /workspace",
        },
        durationMs: Math.round(performance.now() - startTime),
        providerMetadata: {
          provider: this.name,
          operation: request.operationName,
          workspaceMountFailure: true,
        },
      };
    }

    let containerWorkDir = containerMountPath;
    if (isRunCommand && runCommandPayload?.cwd && runCommandPayload.cwd !== ".") {
      const norm = path.posix.normalize(runCommandPayload.cwd.replace(/\\/g, "/"));
      if (norm.startsWith("..") || path.posix.isAbsolute(norm)) {
        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: "Security violation: Working directory must be within workspace",
          },
          durationMs: Math.round(performance.now() - startTime),
          providerMetadata: { provider: this.name, operation: request.operationName },
        };
      }
      containerWorkDir = path.posix.join(containerMountPath, norm);
    }

    const effectiveMaxOutputBytes =
      isRunCommand && typeof runCommandPayload?.maxOutputBytes === "number"
        ? Math.min(runCommandPayload.maxOutputBytes, this.config.maxOutputBytes)
        : this.config.maxOutputBytes;

    // 4. Construct container create arguments (ADR-0040)
    const createArgs: string[] = [
      "create",
      "--name", containerName,
      "--network=none",
      ...(this.config.readOnlyRootfs ? ["--read-only"] : []),
      `--tmpfs=/tmp:rw,noexec,nosuid,size=${this.config.tmpfsSize}`,
      `--memory=${this.config.memoryLimit}`,
      `--cpus=${this.config.cpuLimit}`,
      `--pids-limit=${this.config.pidsLimit}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      `--user=${this.config.runAsUser}`,
      "--label", `${DOCKER_TENANT_LABELS.RUN_ID}=${request.runId}`,
      "--label", `${DOCKER_TENANT_LABELS.ATTEMPT}=${request.attemptNumber}`,
      ...(request.tenantId ? ["--label", `${DOCKER_TENANT_LABELS.TENANT_ID}=${request.tenantId}`] : []),
      ...(request.leaseId ? ["--label", `${DOCKER_TENANT_LABELS.LEASE_ID}=${request.leaseId}`] : []),
      ...(request.workerId ? ["--label", `${DOCKER_TENANT_LABELS.WORKER_ID}=${request.workerId}`] : []),
      ...(request.workspace
        ? [
            "-v",
            `${request.workspace.hostPath}:${containerMountPath}:rw`,
            "-w",
            containerWorkDir,
          ]
        : []),
      ...(isRunCommand
        ? [
            "--entrypoint",
            "",
            this.config.image,
            ...runCommandPayload!.argv,
          ]
        : [
            "-i", // Keep stdin open in container configuration so docker start -i can write to it
            this.config.image,
            "node",
            "-e",
            IN_CONTAINER_RUNNER_SCRIPT,
            request.operationName,
          ]),
    ];

    const elapsed = (): number => Math.round(performance.now() - startTime);
    const baseMeta = { provider: this.name, operation: request.operationName, containerName };

    // Pre-spawn cancellation: an already-aborted signal must never create a container.
    if (request.signal?.aborted) {
      return {
        status: "CANCELLED",
        error: { code: "EXECUTION_CANCELLED", message: "Operation was cancelled before container start" },
        durationMs: elapsed(),
        providerMetadata: { ...baseMeta, preAborted: true, containerCreated: false },
      };
    }

    // The first event wins; every later event (late output, second timer, duplicate abort) is ignored so
    // exactly one outcome is delivered and exactly one termination sequence can start.
    type Decision =
      | { kind: "EXIT"; exitCode: number | null; signal: string | null }
      | { kind: "TIMEOUT" }
      | { kind: "CANCEL" }
      | { kind: "OUTPUT_LIMIT" }
      | { kind: "SPAWN_ERROR"; error: Error };
    let decision: Decision | undefined;
    let resolveDecision!: (d: Decision) => void;
    const decisionPromise = new Promise<Decision>((resolve) => {
      resolveDecision = resolve;
    });
    const decide = (d: Decision): void => {
      if (decision) return;
      decision = d;
      resolveDecision(d);
    };

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let totalBytesReceived = 0;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    let child: DockerChildProcess | undefined;
    let childClosed: Promise<void> = Promise.resolve();
    let terminationPromise: Promise<TerminationOutcome> | undefined;

    const detach = (): void => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (abortListener) {
        request.signal?.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
    };
    // Single-flight: concurrent/repeated callers share one stop -> kill -> verify sequence.
    const terminate = (): Promise<TerminationOutcome> => {
      terminationPromise ??= this.terminateContainer(containerName, request.runId, child, childClosed);
      return terminationPromise;
    };
    const unverified = (cause: string, term: TerminationOutcome): ExecutionResult<TOutput> => ({
      status: "FAILED",
      error: {
        code: "TERMINATION_UNVERIFIED",
        message: `Container termination after ${cause} could not be verified: ${term.reason}`,
        details: { cause, stages: term.stages },
      },
      durationMs: elapsed(),
      providerMetadata: {
        ...baseMeta,
        terminationVerified: false,
        terminationCause: cause,
        physicalTerminationAttempted: true,
      },
    });
    const accumulate = (target: "out" | "err") => (chunk: Buffer): void => {
      if (decision) return; // late output after a decision never accumulates
      totalBytesReceived += chunk.length;
      if (totalBytesReceived > effectiveMaxOutputBytes) {
        decide({ kind: "OUTPUT_LIMIT" });
        return;
      }
      if (target === "out") stdoutBuffer += chunk.toString("utf8");
      else stderrBuffer += chunk.toString("utf8");
    };

    // 5. Early listener/timer registration & docker create via bounded command runner (ADR-0040)
    if (request.timeoutMs > 0 && Number.isFinite(request.timeoutMs)) {
      timeoutTimer = setTimeout(() => decide({ kind: "TIMEOUT" }), request.timeoutMs);
    }
    if (request.signal) {
      abortListener = () => decide({ kind: "CANCEL" });
      request.signal.addEventListener("abort", abortListener, { once: true });
      if (request.signal.aborted) decide({ kind: "CANCEL" });
    }

    let validatedContainerId: string | undefined;
    try {
      const createRes = await this.commandRunner(this.config.dockerBinary, createArgs, {
        timeoutMs: this.config.terminationTimeoutMs,
      });

      if (createRes.exitCode !== 0) {
        detach();
        const daemonError = isDaemonErrorText(createRes.stderr);
        if (!daemonError) {
          await this.cleanupContainer(containerName);
        }
        return {
          status: "FAILED",
          error: {
            code: daemonError ? "PROVIDER_UNAVAILABLE" : "EXECUTION_FAILED",
            message: createRes.stderr.trim() || `docker create failed with exit code ${createRes.exitCode}`,
            details: { exitCode: createRes.exitCode, stderr: createRes.stderr },
          },
          durationMs: elapsed(),
          providerMetadata: {
            ...baseMeta,
            exitCode: createRes.exitCode,
            containerCreated: false,
            ...(daemonError ? { errorType: "DOCKER_UNAVAILABLE" } : {}),
          },
        };
      }

      const rawId = createRes.stdout.trim();
      if (!/^[a-fA-F0-9]{12,64}$/.test(rawId)) {
        detach();
        // Malformed container ID: purge by containerName and verify quiescence
        const term = await this.terminateContainer(containerName, request.runId, undefined, Promise.resolve());
        if (!term.verified) return unverified("malformed-container-id", term);
        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: `Invalid or malformed container ID returned by docker create: '${rawId.slice(0, 100)}'`,
            details: { stdout: rawId, stderr: createRes.stderr },
          },
          durationMs: elapsed(),
          providerMetadata: {
            ...baseMeta,
            malformedContainerId: true,
            rawOutput: rawId.slice(0, 100),
            terminationVerified: true,
            terminationStages: term.stages,
          },
        };
      }
      validatedContainerId = rawId;
    } catch (err: unknown) {
      detach();
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const isSpawnFailure = code === "ENOENT" || code === "EACCES";
      if (!isSpawnFailure) {
        // Create was attempted: daemon may have accepted it. Terminate and verify quiescence.
        const term = await this.terminateContainer(containerName, request.runId, undefined, Promise.resolve());
        if (!term.verified) return unverified("create-error", term);
      }
      const isUnavailable = isSpawnFailure || isDaemonErrorText(msg);
      return {
        status: "FAILED",
        error: {
          code: isUnavailable ? "PROVIDER_UNAVAILABLE" : "EXECUTION_FAILED",
          message: msg,
          details: err instanceof Error ? err.stack : undefined,
        },
        durationMs: elapsed(),
        providerMetadata: {
          ...baseMeta,
          errorType: isUnavailable ? "DOCKER_UNAVAILABLE" : "EXECUTION_ERROR",
        },
      };
    }

    // Post-creation cancellation / timeout check: if decided between create and start, do not start!
    if (decision || request.signal?.aborted) {
      detach();
      const term = await terminate();
      if (!term.verified) return unverified(decision?.kind === "TIMEOUT" ? "timeout" : "cancellation", term);
      if (decision?.kind === "TIMEOUT") {
        return {
          status: "TIMED_OUT",
          error: {
            code: "EXECUTION_TIMEOUT",
            message: `Operation '${request.operationName}' exceeded timeout of ${request.timeoutMs}ms; physical container termination attempted; container termination verified`,
          },
          durationMs: elapsed(),
          providerMetadata: {
            ...baseMeta,
            timeoutMs: request.timeoutMs,
            physicalTerminationAttempted: true,
            terminationVerified: true,
            terminationStages: term.stages,
            containerCreated: true,
          },
        };
      }
      return {
        status: "CANCELLED",
        error: { code: "EXECUTION_CANCELLED", message: "Operation cancelled; container termination verified" },
        durationMs: elapsed(),
        providerMetadata: {
          ...baseMeta,
          physicalTerminationAttempted: true,
          terminationVerified: true,
          terminationStages: term.stages,
          containerCreated: true,
        },
      };
    }

    // 6. Start only the validated container via docker start -a (ADR-0040)
    const startArgs: string[] = [
      "start",
      "-a",
      ...(isRunCommand ? [] : ["-i"]),
      validatedContainerId,
    ];

    try {
      child = this.spawnProcess(this.config.dockerBinary, startArgs);
      const proc = child;
      childClosed = new Promise<void>((resolve) => {
        proc.on("close", () => resolve());
        proc.on("error", () => resolve());
      });
      proc.on("error", (err) => decide({ kind: "SPAWN_ERROR", error: err }));
      proc.on("close", (exitCode, signal) => decide({ kind: "EXIT", exitCode, signal }));
      proc.stdout.on("data", accumulate("out"));
      proc.stderr.on("data", accumulate("err"));
      proc.stdin.on("error", () => {}); // EPIPE if the CLI dies early; the close/error event decides the outcome

      try {
        if (!isRunCommand) proc.stdin.write(inputJson);
        proc.stdin.end();
      } catch {
        // stdin failure surfaces through the close/error event
      }

      const d = await decisionPromise;
      detach();

      if (d.kind === "TIMEOUT") {
        const term = await terminate();
        if (!term.verified) return unverified("timeout", term);
        return {
          status: "TIMED_OUT",
          error: {
            code: "EXECUTION_TIMEOUT",
            message: `Operation '${request.operationName}' exceeded timeout of ${request.timeoutMs}ms; physical container termination attempted; container termination verified`,
          },
          durationMs: elapsed(),
          providerMetadata: {
            ...baseMeta,
            timeoutMs: request.timeoutMs,
            physicalTerminationAttempted: true,
            terminationVerified: true,
            terminationStages: term.stages,
          },
        };
      }
      if (d.kind === "CANCEL") {
        const term = await terminate();
        if (!term.verified) return unverified("cancellation", term);
        return {
          status: "CANCELLED",
          error: {
            code: "EXECUTION_CANCELLED",
            message: "Operation cancelled; container termination verified",
          },
          durationMs: elapsed(),
          providerMetadata: {
            ...baseMeta,
            physicalTerminationAttempted: true,
            terminationVerified: true,
            terminationStages: term.stages,
          },
        };
      }
      if (d.kind === "OUTPUT_LIMIT") {
        const term = await terminate();
        if (!term.verified) return unverified("output-limit", term);
        return {
          status: "FAILED",
          error: {
            code: "OUTPUT_LIMIT_EXCEEDED",
            message: `Output limit of ${effectiveMaxOutputBytes} bytes exceeded by container`,
          },
          durationMs: elapsed(),
          providerMetadata: { ...baseMeta, outputLimitExceeded: true, terminationVerified: true },
        };
      }
      if (d.kind === "SPAWN_ERROR") {
        const code = (d.error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "EACCES") {
          // The CLI started: a container may exist even though the CLI errored.
          const term = await terminate();
          if (!term.verified) return unverified("docker-cli-error", term);
        }
        throw d.error;
      }

      // d.kind === "EXIT": the local CLI is gone. That alone is not proof the container is.
      const { exitCode, signal } = d;

      // Platforms differ: Unix reports a killed CLI as a signal, Windows as a plain non-zero exit code that looks like
      // a failing command. A non-zero exit therefore needs container-state evidence BEFORE the container is removed.
      // Exit 0 cannot come from a killed CLI, 125 is Docker's own launch error, and a daemon-error stderr means no
      // container state can be read; those keep their existing handling.
      const daemonErrorText = isDaemonErrorText(stderrBuffer);
      let ambiguousExit: string | undefined;
      if (signal === null && exitCode !== 0 && exitCode !== 125 && !daemonErrorText) {
        const ev = await this.inspectContainerExit(containerName);
        if (ev.kind === "exited" && ev.exitCode === exitCode) {
          // Container finished and its exit status equals the CLI's: a genuine command exit (kept as-is).
        } else if (ev.kind === "exited") {
          ambiguousExit = `container exit code ${ev.exitCode} differs from the CLI exit code ${String(exitCode)}`;
        } else if (ev.kind === "alive") {
          ambiguousExit = `local CLI exited with ${String(exitCode)} while the container is still '${ev.status}'`;
        } else {
          ambiguousExit = `container state unavailable after CLI exit ${String(exitCode)}: ${ev.reason}`;
        }
      }

      const cleanupOk = await this.cleanupContainer(containerName);
      if (ambiguousExit !== undefined) {
        // We cannot tell an ordinary command failure from an externally killed CLI: use the safest supported result.
        const term = await terminate();
        if (!term.verified) return unverified("docker-cli-exit-ambiguous", term);
        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: `Docker CLI exit could not be confirmed as the command's own exit (${ambiguousExit}); container termination verified`,
            details: { exitCode, ambiguity: ambiguousExit },
          },
          durationMs: elapsed(),
          providerMetadata: {
            ...baseMeta,
            cliExitCode: exitCode,
            exitClassification: "AMBIGUOUS",
            ambiguity: ambiguousExit,
            terminationVerified: true,
            terminationStages: term.stages,
          },
        };
      }
      if (signal !== null) {
        // CLI killed by a signal: the daemon-managed container may still be running.
        const term = await terminate();
        if (!term.verified) return unverified("docker-cli-signal", term);
        // The local CLI was killed, so the command's own outcome is unknown: never report it as a completed
        // command (a null exit code must not become `exitCode: 128` + SUCCESS). Termination itself is verified.
        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: `Local docker CLI was terminated by ${signal}; the command outcome is unknown (container termination verified)`,
            details: { signal },
          },
          durationMs: elapsed(),
          providerMetadata: { ...baseMeta, cliSignal: signal, terminationVerified: true, terminationStages: term.stages },
        };
      } else if (!cleanupOk) {
        // Container should have exited with the CLI, but cleanup failed: require a quiescence verdict.
        const q = await this.verifyQuiescent(request.runId);
        if (!q.verified) {
          return unverified("cleanup-failure", { verified: false, reason: q.reason, stages: ["rm:failed"] });
        }
      }

      const durationMs = elapsed();

      if (isRunCommand) {
        if (daemonErrorText) {
          return {
            status: "FAILED",
            error: {
              code: "PROVIDER_UNAVAILABLE",
              message: stderrBuffer.trim(),
            },
            durationMs,
            providerMetadata: {
              provider: this.name,
              operation: request.operationName,
              containerName,
              errorType: "DOCKER_UNAVAILABLE",
            },
          };
        }

        if (exitCode === 125) {
          return {
            status: "FAILED",
            error: {
              code: "EXECUTION_FAILED",
              message: stderrBuffer.trim() || "Docker daemon failed to launch container",
              details: { exitCode, stderr: stderrBuffer },
            },
            durationMs,
            providerMetadata: {
              provider: this.name,
              operation: request.operationName,
              containerName,
              exitCode,
            },
          };
        }

        const runOutput: RunCommandOutput = {
          exitCode: exitCode ?? (signal ? 128 : 0),
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          durationMs,
          outputTruncated: false,
          commandHash: crypto
            .createHash("sha256")
            .update(JSON.stringify(runCommandPayload!.argv), "utf8")
            .digest("hex"),
        };

        return {
          status: "SUCCESS",
          output: runOutput as unknown as TOutput,
          durationMs,
          providerMetadata: {
            provider: this.name,
            operation: request.operationName,
            containerName,
            exitCode,
            signal,
            attemptNumber: request.attemptNumber,
            idempotencyToken: request.idempotencyToken,
            memoryLimit: this.config.memoryLimit,
            cpuLimit: this.config.cpuLimit,
            networkDisabled: this.config.networkDisabled,
            ...(request.workspace
              ? {
                  workspaceMount: {
                    hostPath: request.workspace.hostPath,
                    containerMountPath,
                    containerWorkDir,
                  },
                }
              : {}),
          },
        };
      }

      if (exitCode !== 0) {
        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: stderrBuffer.trim() || `Container exited with code ${exitCode}`,
            details: { exitCode, stderr: stderrBuffer },
          },
          durationMs,
          providerMetadata: {
            provider: this.name,
            operation: request.operationName,
            containerName,
            exitCode,
          },
        };
      }

      // Parse JSON output from container stdout
      let output: TOutput;
      try {
        output = JSON.parse(stdoutBuffer.trim()) as TOutput;
      } catch (err: unknown) {
        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: `Failed to parse container output as JSON: ${stdoutBuffer.slice(0, 200)}`,
            details: err instanceof Error ? err.message : String(err),
          },
          durationMs,
          providerMetadata: { provider: this.name, operation: request.operationName, containerName },
        };
      }

      return {
        status: "SUCCESS",
        output,
        durationMs,
        providerMetadata: {
          provider: this.name,
          operation: request.operationName,
          containerName,
          attemptNumber: request.attemptNumber,
          idempotencyToken: request.idempotencyToken,
          memoryLimit: this.config.memoryLimit,
          cpuLimit: this.config.cpuLimit,
          networkDisabled: this.config.networkDisabled,
          ...(request.workspace
            ? {
                workspaceMount: {
                  hostPath: request.workspace.hostPath,
                  containerMountPath: request.workspace.containerMountPath ?? "/workspace",
                },
              }
            : {}),
        },
      };
    } catch (err: unknown) {
      detach();
      const durationMs = elapsed();
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const neverStarted = (child === undefined && validatedContainerId === undefined) || code === "ENOENT" || code === "EACCES";
      if (!neverStarted) {
        const term = await terminate();
        if (!term.verified) return unverified("unexpected-error", term);
      }
      const isUnavailable =
        code === "ENOENT" ||
        isDaemonErrorText(msg);

      return {
        status: "FAILED",
        error: {
          code: isUnavailable ? "PROVIDER_UNAVAILABLE" : "EXECUTION_FAILED",
          message: msg,
          details: err instanceof Error ? err.stack : undefined,
        },
        durationMs,
        providerMetadata: {
          ...baseMeta,
          errorType: isUnavailable ? "DOCKER_UNAVAILABLE" : "EXECUTION_ERROR",
        },
      };
    } finally {
      detach();
    }
  }

  /**
   * Validates workspace mount against forbidden host paths, canonical symlink escapes,
   * boundary violations, and multi-tenant partitioning.
   */
  private validateWorkspaceMount(hostPath: string, tenantId?: string, isMultiTenant?: boolean): void {
    if (!hostPath || typeof hostPath !== "string" || hostPath.trim().length === 0) {
      throw new Error("Invalid workspace mount: hostPath must be a non-empty string");
    }

    if (isMultiTenant && (!tenantId || tenantId.trim().length === 0)) {
      throw new Error("Security violation: Multi-tenant workspace mount requires a non-empty tenantId");
    }

    // 1. Raw lexical & named pipe checks
    const rawLower = hostPath.toLowerCase();
    if (
      rawLower.includes("\\\\.\\pipe") ||
      rawLower.includes("docker.sock") ||
      rawLower.includes("docker_engine")
    ) {
      throw new Error("Security violation: Refusing to mount sensitive host directory or socket");
    }

    const resolved = path.resolve(hostPath);

    // 2. Canonical symlink resolution (Workstream 4)
    let canonicalPath = resolved;
    try {
      const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
      if (stat) {
        canonicalPath = fs.realpathSync(resolved);
      } else {
        // Target does not exist yet: resolve existing ancestor to verify no parent symlink escapes
        let cur = path.dirname(resolved);
        while (cur && cur !== path.dirname(cur)) {
          if (fs.existsSync(cur)) {
            const canonicalAncestor = fs.realpathSync(cur);
            canonicalPath = path.join(canonicalAncestor, path.relative(cur, resolved));
            break;
          }
          cur = path.dirname(cur);
        }
      }
    } catch (err: unknown) {
      throw new Error(
        `Security violation: Unable to resolve canonical path for workspace mount '${hostPath}': ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    // 3. Boundary-aware containment helper (prevents prefix confusion: e.g. /ws vs /ws-secret)
    const isPathContainedOrEqual = (target: string, boundary: string): boolean => {
      const normTarget = path.normalize(target).toLowerCase();
      const normBoundary = path.normalize(boundary).toLowerCase();
      if (normTarget === normBoundary) return true;
      const sep = path.sep;
      const boundaryWithSep = normBoundary.endsWith(sep) ? normBoundary : normBoundary + sep;
      return normTarget.startsWith(boundaryWithSep);
    };

    // 4. Validate both lexical resolved and canonical resolved paths against sensitive targets
    const pathsToValidate = resolved === canonicalPath ? [resolved] : [resolved, canonicalPath];
    const home = os.homedir();
    const cwd = process.cwd();
    const sensitiveSystemDirs = [
      "/etc", "/var", "/usr", "/bin", "/sbin", "/lib", "/dev", "/proc", "/sys", "/boot", "/root",
      "c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\programdata"
    ];

    for (const p of pathsToValidate) {
      const norm = path.normalize(p);
      const root = path.parse(norm).root;
      if (norm.toLowerCase() === root.toLowerCase()) {
        throw new Error("Security violation: Refusing to mount host root directory");
      }
      if (norm.toLowerCase() === path.normalize(home).toLowerCase()) {
        throw new Error("Security violation: Refusing to mount host user home directory");
      }
      if (norm.toLowerCase() === path.normalize(cwd).toLowerCase()) {
        throw new Error("Security violation: Refusing to mount current working directory");
      }

      const pLower = norm.toLowerCase();
      if (
        pLower.includes(".ssh") ||
        pLower.includes(".aws") ||
        pLower.includes(".docker") ||
        pLower.includes("docker.sock") ||
        pLower.includes("docker_engine") ||
        pLower.includes("\\\\.\\pipe")
      ) {
        throw new Error("Security violation: Refusing to mount sensitive host directory");
      }

      for (const sysDir of sensitiveSystemDirs) {
        if (isPathContainedOrEqual(norm, sysDir)) {
          throw new Error(`Security violation: Refusing to mount system directory '${sysDir}'`);
        }
      }

      // Cross-tenant confinement: ensure no sibling tenant traversal or cross-tenant paths
      if (tenantId) {
        const normalizedPath = norm.replace(/\\/g, "/");
        const tenantMatch = normalizedPath.match(/\/tenants\/([^/]+)/i);
        if (tenantMatch && tenantMatch[1] && tenantMatch[1] !== tenantId) {
          throw new Error(
            `Security violation: Cross-tenant mount prohibited. Path belongs to tenant '${tenantMatch[1]}', but request is for tenant '${tenantId}'`
          );
        }
      }
    }
  }

  /**
   * Single stop -> kill -> verify sequence for one container. Every step is bounded and failure-tolerant:
   * a failed stop/kill never short-circuits, because only the quiescence verdict decides the outcome.
   * The local CLI is SIGKILLed first so it cannot create the container after verification; killing it does
   * NOT stop a daemon-managed container, which is why stop/kill are issued separately.
   */
  private async terminateContainer(
    containerName: string,
    runId: string,
    child: DockerChildProcess | undefined,
    childClosed: Promise<void>
  ): Promise<TerminationOutcome> {
    const stages: string[] = [];
    const bound = this.config.terminationTimeoutMs;
    const bin = this.config.dockerBinary;
    const run = async (label: string, cmdArgs: string[]): Promise<boolean> => {
      try {
        const r = await this.commandRunner(bin, cmdArgs, { timeoutMs: bound });
        stages.push(`${label}:exit=${r.exitCode}`);
        return r.exitCode === 0;
      } catch (err: unknown) {
        stages.push(`${label}:error=${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    };

    try {
      child?.kill("SIGKILL");
      stages.push("cli-sigkill");
    } catch (err: unknown) {
      stages.push(`cli-sigkill:error=${err instanceof Error ? err.message : String(err)}`);
    }

    // Stage A: graceful stop; Stage B: forced kill only if A did not succeed.
    const stopped = await run("stop", ["stop", "-t", String(this.config.stopGraceSeconds), containerName]);
    if (!stopped) await run("kill", ["kill", containerName]);

    const cliExited = await waitBounded(childClosed, bound);
    stages.push(cliExited ? "cli-closed" : "cli-close-timeout");

    // Stage C: physical quiescence is established by the quiescence port alone.
    const q = await this.verifyQuiescent(runId);
    stages.push(q.verified ? "quiescent" : "unverified");
    if (!cliExited) {
      return { verified: false, reason: "local docker CLI did not exit within the termination bound", stages };
    }
    return { verified: q.verified, reason: q.reason, stages };
  }

  /**
   * Reads the container's own state (before it is removed) so a CLI exit code can be matched to a real container exit.
   * Never throws: any failure or unparsable output is reported as "unknown" and treated as ambiguous by the caller.
   */
  private async inspectContainerExit(
    containerName: string
  ): Promise<
    | { kind: "exited"; exitCode: number }
    | { kind: "alive"; status: string }
    | { kind: "unknown"; reason: string }
  > {
    try {
      const r = await this.commandRunner(
        this.config.dockerBinary,
        ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", containerName],
        { timeoutMs: this.config.terminationTimeoutMs }
      );
      if (r.exitCode !== 0) {
        return { kind: "unknown", reason: `docker inspect exited ${r.exitCode}: ${r.stderr.trim() || r.stdout.trim() || "no output"}` };
      }
      const m = /^(\w+) (-?\d+)$/.exec(r.stdout.trim());
      if (!m) return { kind: "unknown", reason: `malformed docker inspect output: '${r.stdout.trim().slice(0, 80)}'` };
      const status = m[1]!;
      if (status === "exited" || status === "dead") return { kind: "exited", exitCode: Number(m[2]) };
      return { kind: "alive", status };
    } catch (err: unknown) {
      return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private async verifyQuiescent(runId: string): Promise<{ verified: boolean; reason: string }> {
    try {
      const r = await this.quiescence.quiesceRun(runId);
      return r.status === "QUIESCENT"
        ? { verified: true, reason: "quiescent" }
        : { verified: false, reason: r.reason };
    } catch (err: unknown) {
      return { verified: false, reason: `quiescence check threw: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Removes the ephemeral container after the CLI exited. Returns false on failure; the caller then
   * requires a quiescence verdict instead of assuming the container is gone.
   */
  private async cleanupContainer(containerName: string): Promise<boolean> {
    try {
      const r = await this.commandRunner(this.config.dockerBinary, ["rm", "-f", containerName], {
        timeoutMs: this.config.terminationTimeoutMs,
      });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }
}

/** Resolves true when p settles within ms, false on bound expiry. The timer is always cleared. */
function waitBounded(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    void p.then(() => {
      clearTimeout(t);
      resolve(true);
    });
  });
}
