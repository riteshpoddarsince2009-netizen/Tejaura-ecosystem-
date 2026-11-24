import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ContainerSandboxAdapter } from '../index.ts';

interface Harness {
  adapter: ContainerSandboxAdapter;
  sandboxRoot: string;
}

async function findContainerHarness(): Promise<Harness | null> {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-sbx-'));
  for (const dockerCommand of [['docker'], ['sudo', '-n', 'docker']]) {
    const adapter = new ContainerSandboxAdapter({
      dockerCommand,
      sandboxRoot,
      image: 'node:22-alpine',
    });
    const capabilities = await adapter.getCapabilities();
    if (capabilities.available) {
      return { adapter, sandboxRoot };
    }
  }
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
  return null;
}

const harness = await findContainerHarness();
const skipReason = harness
  ? false
  : 'Docker with node:22-alpine is unavailable; container isolation tests skipped.';

function context(input: Record<string, unknown>, timeoutMs = 30_000): any {
  return {
    job: {
      job_id: `job_${Math.random().toString(36).slice(2)}`,
      task_id: `task_${Math.random().toString(36).slice(2)}`,
      agent_id: 'engineering',
      timeout_ms: timeoutMs,
      input,
    },
    agent: {},
    tools: [],
    workspace_root: process.cwd(),
    allowed_paths: [],
    network_mode: 'none',
    network_allowlist: [],
    browser_mode: 'disabled',
    browser_allowlist: [],
    correlation_id: 'corr_sandbox_test',
  };
}

describe('TEJAURA Stage 4.6 — Real Isolated Container Execution', () => {
  after(() => {
    if (harness) {
      fs.rmSync(harness.sandboxRoot, { recursive: true, force: true });
    }
  });

  it(
    'reports real container capabilities and refuses to claim availability when Docker is missing',
    { skip: skipReason },
    async () => {
      const caps = await harness!.adapter.getCapabilities();
      assert.equal(caps.available, true);
      assert.equal(caps.provider_id, 'isolated_container_v1');
      assert.equal(caps.os_isolation, true);
      assert.equal(caps.default_network, 'none');
      assert.ok(caps.runtime_version);
      assert.equal(caps.image_present, true);
    },
  );

  it(
    'executes a probe in a non-root, capability-dropped, network-disabled container',
    { skip: skipReason },
    async () => {
      const result = await harness!.adapter.execute(
        context({ sandbox_operation: 'probe' }),
        new AbortController().signal,
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.result.os_isolated, true);
      assert.equal(result.result.sandbox_provider, 'isolated_container_v1');
      assert.notEqual(result.result.uid, 0);
      const network = result.result.network as Record<string, unknown>;
      const container = result.result.container as Record<string, unknown>;
      assert.equal(network.blocked, true);
      assert.equal(container.network_mode, 'none');
      assert.equal(container.network_enforcement, 'kernel_network_none');
      assert.equal(container.read_only_rootfs, true);
      assert.equal(container.capabilities_dropped, true);
      assert.equal(container.no_new_privileges, true);
      assert.ok(result.result.hostname);
      assert.notEqual(result.result.hostname, os.hostname());
      assert.deepEqual(fs.readdirSync(harness!.sandboxRoot), []);
    },
  );

  it(
    'writes files and runs allowlisted node --test with real test evidence',
    { skip: skipReason },
    async () => {
      const result = await harness!.adapter.execute(
        context({
          sandbox_operation: 'run_tests',
          test_command: 'node --test',
          files: [
            {
              path: 'test.mjs',
              content:
                "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('sandbox arithmetic', () => { assert.equal(2 + 2, 4); });\n",
            },
          ],
        }),
        new AbortController().signal,
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepEqual(result.result.changed_files, ['test.mjs']);
      const evidence = result.result.test_evidence as Record<string, unknown>;
      assert.equal(evidence.executed, true);
      assert.equal(evidence.exit_code, 0);
      assert.equal(evidence.test_failed, false);
      assert.match(String(evidence.output), /# pass 1/);
      assert.equal((result.result.network as Record<string, unknown>).blocked, true);
    },
  );

  it(
    'fails closed for path traversal, arbitrary shell, and unconfigured egress',
    { skip: skipReason },
    async () => {
      const traversal = await harness!.adapter.execute(
        context({
          sandbox_operation: 'write_files',
          files: [{ path: '../escape.txt', content: 'escape' }],
        }),
        new AbortController().signal,
      );
      assert.equal(traversal.ok, false);
      if (!traversal.ok) {
        assert.match(traversal.error.message, /PATH_TRAVERSAL_FORBIDDEN/);
      }

      const shell = await harness!.adapter.execute(
        context({
          sandbox_operation: 'probe',
          requested_shell_command: 'rm -rf /',
        }),
        new AbortController().signal,
      );
      assert.equal(shell.ok, false);
      if (!shell.ok) {
        assert.equal(shell.error.code, 'SHELL_EXECUTION_FORBIDDEN');
      }

      const egressContext = context({ sandbox_operation: 'probe' });
      egressContext.network_mode = 'allowlisted_endpoints';
      const egress = await harness!.adapter.execute(
        egressContext,
        new AbortController().signal,
      );
      assert.equal(egress.ok, false);
      if (!egress.ok) {
        assert.equal(egress.error.code, 'CONTAINER_NETWORK_ALLOWLIST_UNSUPPORTED');
      }
    },
  );
});
