import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const WORKSPACE = '/workspace';
const MAX_OUTPUT_BYTES = 64 * 1024;

function send(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function safePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('PATH_REQUIRED');
  }
  if (relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    throw new Error('ABSOLUTE_PATH_FORBIDDEN');
  }
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error('PATH_TRAVERSAL_FORBIDDEN');
  }
  const resolved = path.resolve(WORKSPACE, normalized);
  if (resolved !== WORKSPACE && !resolved.startsWith(`${WORKSPACE}${path.sep}`)) {
    throw new Error('WORKSPACE_BOUNDARY_VIOLATION');
  }
  return resolved;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > 512 * 1024) {
        reject(new Error('JOB_INPUT_TOO_LARGE'));
        process.stdin.destroy();
      }
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function truncate(value, max = MAX_OUTPUT_BYTES) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n[TRUNCATED]`;
}

function runProcess(executable, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(executable, args, {
      cwd: WORKSPACE,
      shell: false,
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/tmp',
        CI: '1',
        NODE_ENV: 'test',
        TEJAURA_SANDBOX: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const append = (target, chunk) => {
      if (target === 'stdout') {
        stdout = truncate(stdout + chunk.toString());
      } else {
        stderr = truncate(stderr + chunk.toString());
      }
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exit_code: null,
        stdout,
        stderr: truncate(`${stderr}${err.message}`),
        timed_out: timedOut,
        duration_ms: Date.now() - started,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exit_code: code,
        stdout,
        stderr,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
      });
    });
  });
}

function resolveTestCommand(command) {
  if (command === 'node --test') {
    return { executable: 'node', args: ['--test'] };
  }
  if (command === 'python -m unittest') {
    return { executable: 'python3', args: ['-m', 'unittest', 'discover', '-v'] };
  }
  if (command === 'pytest') {
    return { executable: 'pytest', args: ['-q'] };
  }
  throw new Error('TEST_COMMAND_NOT_ALLOWED');
}

async function networkProbe() {
  try {
    await fetch('https://example.com', {
      signal: AbortSignal.timeout(1500),
      redirect: 'manual',
    });
    return { blocked: false, detail: 'outbound HTTPS request succeeded' };
  } catch (err) {
    return {
      blocked: true,
      detail: err instanceof Error ? err.message : 'network request failed',
    };
  }
}

async function main() {
  const raw = await readStdin();
  let job;
  try {
    job = JSON.parse(raw);
  } catch {
    send({ ok: false, error: { code: 'INVALID_JOB_JSON', message: 'Job input is not valid JSON.' } });
    return;
  }
  const operation = typeof job.operation === 'string' ? job.operation : 'probe';
  const started = Date.now();
  const base = {
    ok: true,
    operation,
    cwd: process.cwd(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    gid: typeof process.getgid === 'function' ? process.getgid() : null,
    hostname: process.env.HOSTNAME ?? null,
    sandbox_marker: process.env.TEJAURA_SANDBOX ?? null,
    changed_files: [],
  };

  try {
    if (operation === 'probe') {
      send({
        ...base,
        network: await networkProbe(),
        resource_usage: process.resourceUsage(),
      });
      return;
    }

    if (operation === 'write_files' || operation === 'run_tests') {
      const files = Array.isArray(job.files) ? job.files : [];
      if (files.length > 50) {
        send({ ok: false, error: { code: 'TOO_MANY_FILES', message: 'At most 50 files may be written.' } });
        return;
      }
      for (const file of files) {
        const target = safePath(file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, String(file.content ?? ''), {
          encoding: 'utf8',
          mode: 0o600,
        });
        base.changed_files.push(path.relative(WORKSPACE, target));
      }
    }

    if (operation === 'read_files') {
      const paths = Array.isArray(job.paths) ? job.paths : [];
      const files = [];
      for (const relative of paths.slice(0, 50)) {
        const target = safePath(relative);
        files.push({
          path: path.relative(WORKSPACE, target),
          content: truncate(fs.readFileSync(target, 'utf8'), 200_000),
        });
      }
      send({ ...base, files, resource_usage: process.resourceUsage() });
      return;
    }

    if (operation === 'list_workspace') {
      const entries = fs.readdirSync(WORKSPACE, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }));
      send({ ...base, entries, resource_usage: process.resourceUsage() });
      return;
    }

    if (operation === 'run_tests') {
      const command = typeof job.test_command === 'string' ? job.test_command : 'node --test';
      const resolved = resolveTestCommand(command);
      const timeoutMs = Math.max(1_000, Math.min(120_000, Number(job.test_timeout_ms) || 20_000));
      const run = await runProcess(resolved.executable, resolved.args, timeoutMs);
      const testFailed = run.exit_code !== 0 || run.timed_out;
      send({
        ...base,
        ok: true,
        test_evidence: {
          executed: true,
          command,
          exit_code: run.exit_code,
          timed_out: run.timed_out,
          duration_ms: run.duration_ms,
          output: truncate(`${run.stdout}\n${run.stderr}`.trim()),
          test_failed: testFailed,
        },
        network: await networkProbe(),
        resource_usage: process.resourceUsage(),
      });
      return;
    }

    send({ ok: false, error: { code: 'UNSUPPORTED_SANDBOX_OPERATION', message: `Unsupported operation "${operation}".` } });
  } catch (err) {
    send({
      ok: false,
      error: {
        code: 'SANDBOX_RUNNER_ERROR',
        message: err instanceof Error ? err.message : 'Sandbox runner failed.',
        duration_ms: Date.now() - started,
      },
    });
  }
}

void main();
