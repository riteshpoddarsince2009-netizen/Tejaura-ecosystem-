import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  SandboxAdapter,
  SandboxAdapterOutcome,
  SandboxExecutionContext,
} from './execution-types.ts';
import { redactSensitiveValue } from './secret-redactor.ts';

const RUNNER_PATH = fileURLToPath(new URL('./container-runner.mjs', import.meta.url));
const ALLOWED_TEST_COMMANDS = new Set([
  'node --test',
  'python -m unittest',
  'pytest',
]);
const ALLOWED_OPERATIONS = new Set([
  'probe',
  'write_files',
  'read_files',
  'list_workspace',
  'run_tests',
]);

export interface ContainerSandboxCapabilities {
  available: boolean;
  provider_id: string;
  runtime: string;
  runtime_version: string | null;
  image: string;
  image_present: boolean;
  os_isolation: boolean;
  default_network: 'none';
  network_allowlist_supported: boolean;
  network_allowlist_enforcement: 'http_proxy' | 'none';
  non_root_execution: boolean;
  checked_at: string;
  reasons: string[];
}

export interface ContainerSandboxAdapterOptions {
  dockerCommand?: string[];
  image?: string;
  sandboxRoot?: string;
  memoryLimit?: string;
  cpuLimit?: string;
  pidsLimit?: number;
  testTimeoutMs?: number;
  knownSecretValues?: readonly string[];
  clock?: () => Date;
}

interface DockerRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function truncate(value: string, max = 128 * 1024): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[TRUNCATED]`;
}

/**
 * Production-oriented container sandbox adapter.
 *
 * Each task runs in a fresh container with:
 * - a dedicated bind-mounted workspace
 * - non-root UID/GID
 * - read-only root filesystem
 * - no network by default
 * - dropped Linux capabilities and no-new-privileges
 * - CPU, memory, PID, file-descriptor, and wall-clock limits
 *
 * It never silently falls back to in-process execution. If Docker (or the
 * configured container runtime) is unavailable, `execute` fails closed.
 */
export class ContainerSandboxAdapter implements SandboxAdapter {
  readonly providerId = 'isolated_container_v1';
  readonly isolationLevel = 'isolated_container' as const;
  readonly supportsOsIsolation = true;
  readonly isolationDisclaimer =
    'Runs each task in a non-root, capability-dropped, network-disabled Docker container with a dedicated workspace. Requires a working container runtime on the host.';

  private readonly dockerCommand: string[];
  private readonly image: string;
  private readonly sandboxRoot: string;
  private readonly memoryLimit: string;
  private readonly cpuLimit: string;
  private readonly pidsLimit: number;
  private readonly testTimeoutMs: number;
  private readonly knownSecretValues: readonly string[];
  private readonly clock: () => Date;
  private capabilityCache: { atMs: number; value: ContainerSandboxCapabilities } | null = null;

  constructor(options: ContainerSandboxAdapterOptions = {}) {
    this.dockerCommand = options.dockerCommand ?? ['docker'];
    this.image = options.image ?? 'node:22-alpine';
    this.sandboxRoot = path.resolve(
      options.sandboxRoot ?? path.join(process.cwd(), 'sandbox', 'executions'),
    );
    this.memoryLimit = options.memoryLimit ?? '256m';
    this.cpuLimit = options.cpuLimit ?? '0.5';
    this.pidsLimit = Math.max(16, Math.min(512, options.pidsLimit ?? 64));
    this.testTimeoutMs = Math.max(1_000, Math.min(120_000, options.testTimeoutMs ?? 20_000));
    this.knownSecretValues = options.knownSecretValues ?? [];
    this.clock = options.clock ?? (() => new Date());
  }

  private async runDocker(
    args: string[],
    options: {
      stdin?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      maxOutputBytes?: number;
    } = {},
  ): Promise<DockerRunResult> {
    return new Promise((resolve) => {
      const maxOutput = options.maxOutputBytes ?? 128 * 1024;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const child = spawn(this.dockerCommand[0]!, [...this.dockerCommand.slice(1), ...args], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs ?? 30_000);
      const onAbort = () => {
        timedOut = false;
        child.kill('SIGKILL');
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk) => {
        stdout = truncate(stdout + chunk.toString(), maxOutput);
      });
      child.stderr.on('data', (chunk) => {
        stderr = truncate(stderr + chunk.toString(), maxOutput);
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({
          code: null,
          stdout,
          stderr: truncate(`${stderr}${err.message}`),
          timedOut,
        });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({ code, stdout, stderr, timedOut });
      });

      if (options.stdin !== undefined) {
        child.stdin.write(options.stdin);
      }
      child.stdin.end();
    });
  }

  async getCapabilities(): Promise<ContainerSandboxCapabilities> {
    const nowMs = this.clock().getTime();
    if (this.capabilityCache && nowMs - this.capabilityCache.atMs < 10_000) {
      return this.capabilityCache.value;
    }
    const reasons: string[] = [];
    const version = await this.runDocker(['info', '--format', '{{.ServerVersion}}'], {
      timeoutMs: 5_000,
    });
    const runtimeVersion =
      version.code === 0 && version.stdout.trim().length > 0
        ? version.stdout.trim()
        : null;
    if (!runtimeVersion) {
      reasons.push(
        `Container runtime unavailable via "${this.dockerCommand.join(' ')}": ${
          version.stderr.trim() || 'no server version returned'
        }`,
      );
    }
    const imageInspect = await this.runDocker(['image', 'inspect', this.image], {
      timeoutMs: 5_000,
    });
    const imagePresent = imageInspect.code === 0;
    if (!imagePresent && runtimeVersion) {
      reasons.push(
        `Sandbox image "${this.image}" is not present locally. Pre-pull it before enabling the container provider.`,
      );
    }
    // A Docker bridge plus HTTP_PROXY is not an enforcement boundary: processes can
    // ignore proxy variables and reach the network directly. Fail closed until a
    // network-layer allowlist is implemented.
    const networkAllowlistSupported = false;
    reasons.push(
      'Allowlisted egress is not implemented. All sandbox containers run with --network=none.',
    );
    const value: ContainerSandboxCapabilities = {
      available: runtimeVersion !== null && imagePresent,
      provider_id: this.providerId,
      runtime: this.dockerCommand.join(' '),
      runtime_version: runtimeVersion,
      image: this.image,
      image_present: imagePresent,
      os_isolation: true,
      default_network: 'none',
      network_allowlist_supported: networkAllowlistSupported,
      network_allowlist_enforcement: networkAllowlistSupported ? 'http_proxy' : 'none',
      non_root_execution: true,
      checked_at: this.clock().toISOString(),
      reasons,
    };
    this.capabilityCache = { atMs: nowMs, value };
    return value;
  }

  async checkHealth(): Promise<{ healthy: boolean; details: ContainerSandboxCapabilities }> {
    const details = await this.getCapabilities();
    return { healthy: details.available, details };
  }

  private buildContainerArgs(params: {
    containerName: string;
    workspace: string;
    job: SandboxExecutionContext['job'];
    uid: number;
    gid: number;
  }): string[] {
    const args = [
      'run',
      '--rm',
      '-i',
      '--name',
      params.containerName,
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(this.pidsLimit),
      '--memory',
      this.memoryLimit,
      '--memory-swap',
      this.memoryLimit,
      '--cpus',
      this.cpuLimit,
      '--ulimit',
      'nofile=256:256',
      '--user',
      `${params.uid}:${params.gid}`,
      '--workdir',
      '/workspace',
      '--label',
      `tejaura.task_id=${params.job.task_id}`,
      '--label',
      `tejaura.job_id=${params.job.job_id}`,
      '--label',
      `tejaura.agent_id=${params.job.agent_id}`,
      '--env',
      'HOME=/tmp',
      '--env',
      'TEJAURA_SANDBOX=1',
      '--volume',
      `${params.workspace}:/workspace:rw`,
      '--volume',
      `${RUNNER_PATH}:/opt/tejaura/runner.mjs:ro`,
    ];
    args.push(this.image, 'node', '/opt/tejaura/runner.mjs');
    return args;
  }

  async execute(
    context: SandboxExecutionContext,
    signal: AbortSignal,
  ): Promise<SandboxAdapterOutcome> {
    if (signal.aborted) {
      return {
        ok: false,
        error: {
          code: 'EXECUTION_CANCELLED',
          message: 'Container sandbox job was aborted before execution started.',
          retryable: false,
        },
      };
    }

    const capabilities = await this.getCapabilities();
    if (!capabilities.available) {
      return {
        ok: false,
        error: {
          code: 'CONTAINER_RUNTIME_UNAVAILABLE',
          message: capabilities.reasons.join(' '),
          retryable: false,
        },
      };
    }

    if (context.network_mode === 'allowlisted_endpoints' && !capabilities.network_allowlist_supported) {
      return {
        ok: false,
        error: {
          code: 'CONTAINER_NETWORK_ALLOWLIST_UNSUPPORTED',
          message:
            'Allowlisted egress requires a configured HTTP egress proxy. The container adapter fails closed instead of granting unrestricted network access.',
          retryable: false,
        },
      };
    }
    if (context.browser_mode !== 'disabled') {
      return {
        ok: false,
        error: {
          code: 'CONTAINER_BROWSER_MODE_UNSUPPORTED',
          message:
            'Browser access is not available in the container sandbox. Use a dedicated browser worker with its own isolation.',
          retryable: false,
        },
      };
    }

    const jobInput = context.job.input;
    if (typeof jobInput.requested_shell_command === 'string' && jobInput.requested_shell_command.trim()) {
      return {
        ok: false,
        error: {
          code: 'SHELL_EXECUTION_FORBIDDEN',
          message: 'Arbitrary shell execution is forbidden in the container sandbox.',
          retryable: false,
        },
      };
    }
    const operation =
      typeof jobInput.sandbox_operation === 'string'
        ? jobInput.sandbox_operation
        : 'probe';
    if (!ALLOWED_OPERATIONS.has(operation)) {
      return {
        ok: false,
        error: {
          code: 'UNSUPPORTED_SANDBOX_OPERATION',
          message: `Sandbox operation "${operation}" is not allowlisted.`,
          retryable: false,
        },
      };
    }
    if (operation === 'run_tests') {
      const command =
        typeof jobInput.test_command === 'string' ? jobInput.test_command : 'node --test';
      if (!ALLOWED_TEST_COMMANDS.has(command)) {
        return {
          ok: false,
          error: {
            code: 'TEST_COMMAND_NOT_ALLOWED',
            message: `Test command "${command}" is not allowlisted.`,
            retryable: false,
          },
        };
      }
    }

    fs.mkdirSync(this.sandboxRoot, { recursive: true, mode: 0o700 });
    const workspace = fs.mkdtempSync(path.join(this.sandboxRoot, 'task-'));
    fs.chmodSync(workspace, 0o700);
    const hostUid = typeof process.getuid === 'function' ? process.getuid() : 10001;
    const hostGid = typeof process.getgid === 'function' ? process.getgid() : 10001;
    // Never run the container as root, even if the service itself was started as root.
    const sandboxUid = hostUid === 0 ? 10001 : hostUid;
    const sandboxGid = hostUid === 0 ? 10001 : hostGid;
    if (hostUid === 0) {
      try {
        fs.chownSync(workspace, sandboxUid, sandboxGid);
      } catch {
        // The workspace remains root-owned; the runner will report a write failure.
      }
    }
    const containerName = `tejaura-sbx-${context.job.job_id.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${crypto
      .randomUUID()
      .slice(0, 8)}`;
    const args = this.buildContainerArgs({
      containerName,
      workspace,
      job: context.job,
      uid: sandboxUid,
      gid: sandboxGid,
    });
    const jobPayload = JSON.stringify({
      operation,
      files: Array.isArray(jobInput.files) ? jobInput.files : [],
      paths: Array.isArray(jobInput.paths) ? jobInput.paths : [],
      test_command: jobInput.test_command,
      test_timeout_ms: Math.min(this.testTimeoutMs, context.job.timeout_ms),
    });

    const started = Date.now();
    try {
      const run = await this.runDocker(args, {
        stdin: jobPayload,
        timeoutMs: context.job.timeout_ms + 10_000,
        signal,
        maxOutputBytes: 256 * 1024,
      });
      if (run.timedOut) {
        return {
          ok: false,
          error: {
            code: 'CONTAINER_TIMEOUT',
            message: `Container execution exceeded the ${context.job.timeout_ms}ms task timeout.`,
            retryable: false,
          },
        };
      }
      if (signal.aborted) {
        return {
          ok: false,
          error: {
            code: 'EXECUTION_CANCELLED',
            message: 'Container execution was cancelled.',
            retryable: false,
          },
        };
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(run.stdout) as Record<string, unknown>;
      } catch {
        return {
          ok: false,
          error: {
            code: 'CONTAINER_RUNNER_INVALID_OUTPUT',
            message: `Container runner returned invalid JSON. stderr: ${truncate(run.stderr, 2000)}`,
            retryable: true,
          },
        };
      }
      if (parsed.ok !== true) {
        const error = parsed.error && typeof parsed.error === 'object'
          ? (parsed.error as Record<string, unknown>)
          : {};
        return {
          ok: false,
          error: {
            code: typeof error.code === 'string' ? error.code : 'CONTAINER_RUNNER_ERROR',
            message:
              typeof error.message === 'string'
                ? error.message
                : 'Container runner reported an error.',
            retryable: false,
          },
        };
      }

      const result = this.redact({
        ...parsed,
        sandbox_provider: this.providerId,
        isolation_level: this.isolationLevel,
        os_isolated: true,
        container: {
          image: this.image,
          network_mode: 'none',
          network_enforcement: 'kernel_network_none',
          non_root_uid: sandboxUid,
          read_only_rootfs: true,
          capabilities_dropped: true,
          no_new_privileges: true,
          pids_limit: this.pidsLimit,
          memory_limit: this.memoryLimit,
          cpu_limit: this.cpuLimit,
        },
        duration_ms: Date.now() - started,
        stderr: truncate(run.stderr, 4000),
      }) as Record<string, unknown>;
      return { ok: true, result };
    } finally {
      await this.runDocker(['rm', '-f', containerName], { timeoutMs: 5_000 }).catch(() => undefined);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }

  private redact(value: unknown): unknown {
    return redactSensitiveValue(value, this.knownSecretValues).value;
  }
}
