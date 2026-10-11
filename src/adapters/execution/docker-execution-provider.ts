import { execFile, spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../ports/execution-provider.port.js";

const execFileAsync = promisify(execFile);

export interface DockerExecutionConfig {
  readonly image?: string; // Default: "node:22-alpine"
  readonly memoryLimit?: string; // Default: "256m"
  readonly cpuLimit?: string; // Default: "0.5"
  readonly pidsLimit?: number; // Default: 64
  readonly tmpfsSize?: string; // Default: "64m"
  readonly maxOutputBytes?: number; // Default: 1024 * 1024 (1 MB)
  readonly networkDisabled?: boolean; // Default: true (--network=none)
  readonly readOnlyRootfs?: boolean; // Default: true (--read-only)
  readonly dockerBinary?: string; // Default: "docker"
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
  readonly config: Required<DockerExecutionConfig>;

  constructor(config: DockerExecutionConfig = {}) {
    if (config.networkDisabled === false) {
      throw new Error(
        "Network access is not available: Phase 3 enforces network = NONE without explicit governance capability architecture."
      );
    }

    this.config = {
      image: config.image ?? "node:22-alpine",
      memoryLimit: config.memoryLimit ?? "256m",
      cpuLimit: config.cpuLimit ?? "0.5",
      pidsLimit: config.pidsLimit ?? 64,
      tmpfsSize: config.tmpfsSize ?? "64m",
      maxOutputBytes: config.maxOutputBytes ?? 1024 * 1024,
      networkDisabled: true,
      readOnlyRootfs: config.readOnlyRootfs ?? true,
      dockerBinary: config.dockerBinary ?? "docker",
    };
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

    // 2. Validate input payload serializability
    let inputJson: string;
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

    // 3. Ephemeral container identity
    const containerId = crypto.randomUUID().slice(0, 12);
    const containerName = `emerald-run-${containerId}`;

    // Validate workspace mount if present
    if (request.workspace) {
      try {
        this.validateWorkspaceMount(request.workspace.hostPath);
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

    // 4. Construct container run arguments
    const args: string[] = [
      "run",
      "--name", containerName,
      "--network=none",
      ...(this.config.readOnlyRootfs ? ["--read-only"] : []),
      `--tmpfs=/tmp:rw,noexec,nosuid,size=${this.config.tmpfsSize}`,
      `--memory=${this.config.memoryLimit}`,
      `--cpus=${this.config.cpuLimit}`,
      `--pids-limit=${this.config.pidsLimit}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      ...(request.workspace
        ? [
            "-v",
            `${request.workspace.hostPath}:${containerMountPath}:rw`,
            "-w",
            containerMountPath,
          ]
        : []),
      "-i", // Connect container stdin
      this.config.image,
      "node",
      "-e",
      IN_CONTAINER_RUNNER_SCRIPT,
      request.operationName,
    ];

    let timedOut = false;
    let outputLimitExceeded = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let totalBytesReceived = 0;
    let timeoutTimer: NodeJS.Timeout | undefined;

    try {
      const child = spawn(this.config.dockerBinary, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const executionPromise = new Promise<{ exitCode: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.on("error", (err) => {
            reject(err);
          });

          child.stdout.on("data", (chunk: Buffer) => {
            totalBytesReceived += chunk.length;
            if (totalBytesReceived > this.config.maxOutputBytes) {
              outputLimitExceeded = true;
              this.killContainer(containerName).catch(() => {});
              child.kill("SIGKILL");
              return;
            }
            stdoutBuffer += chunk.toString("utf8");
          });

          child.stderr.on("data", (chunk: Buffer) => {
            totalBytesReceived += chunk.length;
            if (totalBytesReceived > this.config.maxOutputBytes) {
              outputLimitExceeded = true;
              this.killContainer(containerName).catch(() => {});
              child.kill("SIGKILL");
              return;
            }
            stderrBuffer += chunk.toString("utf8");
          });

          child.on("close", (exitCode, signal) => {
            resolve({ exitCode, signal });
          });
        }
      );

      // Write payload to container stdin and close stream
      child.stdin.write(inputJson);
      child.stdin.end();

      // Configure timeout and physical termination
      let timeoutPromise: Promise<never> | undefined;
      if (request.timeoutMs > 0 && Number.isFinite(request.timeoutMs)) {
        timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            timedOut = true;
            // Attempt physical termination of the container process
            this.killContainer(containerName).catch(() => {});
            child.kill("SIGKILL");
            reject(new Error(`Operation exceeded timeout limit of ${request.timeoutMs}ms`));
          }, request.timeoutMs);
        });
      }

      const { exitCode } = timeoutPromise
        ? await Promise.race([executionPromise, timeoutPromise])
        : await executionPromise;

      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }

      const durationMs = Math.round(performance.now() - startTime);

      if (outputLimitExceeded) {
        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: `Output limit of ${this.config.maxOutputBytes} bytes exceeded by container`,
          },
          durationMs,
          providerMetadata: {
            provider: this.name,
            operation: request.operationName,
            containerName,
            outputLimitExceeded: true,
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
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }

      const durationMs = Math.round(performance.now() - startTime);

      if (timedOut) {
        return {
          status: "TIMED_OUT",
          error: {
            code: "EXECUTION_TIMEOUT",
            message: `Operation '${request.operationName}' exceeded logical timeout of ${request.timeoutMs}ms; physical container termination attempted`,
          },
          durationMs,
          providerMetadata: {
            provider: this.name,
            operation: request.operationName,
            containerName,
            timeoutMs: request.timeoutMs,
            physicalTerminationAttempted: true,
          },
        };
      }

      const msg = err instanceof Error ? err.message : String(err);
      const isUnavailable =
        msg.includes("ENOENT") ||
        msg.includes("docker API") ||
        msg.includes("dockerDesktopLinuxEngine") ||
        msg.includes("daemon is not running");

      return {
        status: "FAILED",
        error: {
          code: isUnavailable ? "PROVIDER_UNAVAILABLE" : "EXECUTION_FAILED",
          message: msg,
          details: err instanceof Error ? err.stack : undefined,
        },
        durationMs,
        providerMetadata: {
          provider: this.name,
          operation: request.operationName,
          containerName,
          errorType: isUnavailable ? "DOCKER_UNAVAILABLE" : "EXECUTION_ERROR",
        },
      };
    } finally {
      // Unconditional container cleanup: ensure no ephemeral containers are left running or stopped
      await this.cleanupContainer(containerName);
    }
  }

  /**
   * Validates workspace mount against forbidden host paths.
   */
  private validateWorkspaceMount(hostPath: string): void {
    if (!hostPath || typeof hostPath !== "string" || hostPath.trim().length === 0) {
      throw new Error("Invalid workspace mount: hostPath must be a non-empty string");
    }
    const resolved = path.resolve(hostPath);
    const root = path.parse(resolved).root;
    if (resolved === root) {
      throw new Error("Security violation: Refusing to mount host root directory");
    }
    const home = os.homedir();
    if (resolved === path.resolve(home)) {
      throw new Error("Security violation: Refusing to mount host user home directory");
    }
    const cwd = process.cwd();
    if (resolved === path.resolve(cwd)) {
      throw new Error("Security violation: Refusing to mount current working directory");
    }
    const lower = resolved.toLowerCase();
    if (
      lower.includes(".ssh") ||
      lower.includes(".aws") ||
      lower.includes(".docker") ||
      lower.includes("docker.sock")
    ) {
      throw new Error("Security violation: Refusing to mount sensitive host directory");
    }

    const sensitiveSystemDirs = [
      "/etc", "/var", "/usr", "/bin", "/sbin", "/lib", "/dev", "/proc", "/sys",
      "c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\programdata"
    ];
    for (const sysDir of sensitiveSystemDirs) {
      if (lower === sysDir || lower.startsWith(sysDir + path.sep)) {
        throw new Error(`Security violation: Refusing to mount system directory '${sysDir}'`);
      }
    }
  }

  /**
   * Attempts physical termination of a running container.
   */
  private async killContainer(containerName: string): Promise<void> {
    try {
      await execFileAsync(this.config.dockerBinary, ["kill", containerName]);
    } catch {
      // Container may have already exited
    }
  }

  /**
   * Unconditionally removes the ephemeral container.
   */
  private async cleanupContainer(containerName: string): Promise<void> {
    try {
      await execFileAsync(this.config.dockerBinary, ["rm", "-f", containerName]);
    } catch {
      // Ignore cleanup error if already removed
    }
  }
}
