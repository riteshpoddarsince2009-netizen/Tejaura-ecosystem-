import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import systemConfig from '../../core/configuration/system.json' with { type: 'json' };
import { ApprovalService } from '../../core/approvals/index.ts';
import { AuditLogger, InMemoryAuditStorage } from '../../core/audit/index.ts';
import { SqliteOrchestrationStore } from '../../control-plane/db/index.ts';
import {
  AgentSandboxExecutor,
  DelegationEngine,
  SqliteDelegationStore,
} from '../../agents/index.ts';
import type { DelegationTaskRecord } from '../../agents/index.ts';
import { AgentExecutionEngine, ContainerSandboxAdapter } from '../index.ts';

async function findDockerCommand(): Promise<string[] | null> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-sbx-integration-'));
  try {
    for (const dockerCommand of [['docker'], ['sudo', '-n', 'docker']]) {
      const adapter = new ContainerSandboxAdapter({ dockerCommand, sandboxRoot: root });
      const caps = await adapter.getCapabilities();
      if (caps.available) return dockerCommand;
    }
    return null;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const dockerCommand = await findDockerCommand();
const skipReason = dockerCommand
  ? false
  : 'Docker with node:22-alpine is unavailable; executor integration test skipped.';

function engineeringTask(): DelegationTaskRecord {
  const now = new Date().toISOString();
  return {
    task_id: 'dtask_integration_engineering',
    project_id: 'dproj_integration',
    parent_task_id: 'dtask_integration_root',
    root_task_id: 'dtask_integration_root',
    agent_id: 'engineering',
    department: 'engineering',
    status: 'RUNNING',
    action: 'agent:write_code',
    resource_id: 'dproj_integration',
    environment: 'sandbox',
    title: 'Implement and test the increment',
    description: 'Write a bounded test file and run allowlisted tests.',
    input: {},
    output: null,
    error: null,
    risk_level: 'medium',
    approval_id: null,
    approval_required: false,
    depth: 1,
    max_depth: 3,
    retry_count: 0,
    max_retries: 1,
    timeout_ms: 30_000,
    idempotency_key: null,
    dependencies: [],
    child_task_ids: [],
    correlation_id: 'corr_executor_integration',
    cancellation_requested: false,
    started_at: now,
    finished_at: null,
    created_at: now,
    updated_at: now,
  };
}

describe('TEJAURA Stage 4.6 — Delegation to Real Container Executor', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-sbx-integration-db-'));
  after(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it(
    'authorizes an engineering delegation and returns real container test evidence',
    { skip: skipReason },
    async () => {
      const store = new SqliteOrchestrationStore({ dbPath: path.join(stateDir, 'cp.db') });
      const auditLogger = new AuditLogger({ storage: new InMemoryAuditStorage() });
      const approvals = new ApprovalService({
        designatedOwnerId: 'owner_primary',
        auditLogger,
      });
      const sandboxRoot = path.join(stateDir, 'sandbox');
      const container = new ContainerSandboxAdapter({
        dockerCommand: dockerCommand!,
        sandboxRoot,
        image: 'node:22-alpine',
      });
      const engine = new AgentExecutionEngine({
        store,
        approvals,
        auditLogger,
        systemConfig,
        policyConfig: {
          workspaceRoot: process.cwd(),
          allowedRelativePaths: ['sandbox'],
          defaultNetworkMode: 'none',
          defaultBrowserMode: 'disabled',
        },
        adapters: [container],
        defaultSandboxProvider: 'isolated_container_v1',
      });
      const executor = new AgentSandboxExecutor({
        executionEngine: engine,
        providerId: 'isolated_container_v1',
        allowSimulatedProvider: false,
      });
      const result = await executor.runEngineeringTask({
        task: engineeringTask(),
        agentId: 'engineering',
        input: {
          files: [
            {
              path: 'test.mjs',
              content:
                "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('integration', () => { assert.equal(3 * 3, 9); });\n",
            },
          ],
          test_command: 'node --test',
        },
        signal: new AbortController().signal,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const output = result.result ?? {};
      assert.equal(output.os_isolated, true);
      assert.equal(output.simulated, false);
      assert.equal(output.sandbox_provider, 'isolated_container_v1');
      assert.deepEqual(output.changed_files, ['test.mjs']);
      const evidence = output.test_evidence as Record<string, unknown>;
      assert.equal(evidence.executed, true);
      assert.equal(evidence.exit_code, 0);
      assert.equal(evidence.simulated, false);
      assert.match(String(evidence.output), /# pass 1/);
      store.close();
    },
  );

  it(
    'runs an owner objective with supplied files through the real container executor',
    { skip: skipReason },
    async () => {
      const delegationStateDir = path.join(stateDir, 'delegation-objective');
      fs.mkdirSync(delegationStateDir, { recursive: true });
      const execStore = new SqliteOrchestrationStore({
        dbPath: path.join(delegationStateDir, 'exec.db'),
      });
      const delegationStore = new SqliteDelegationStore({
        dbPath: path.join(delegationStateDir, 'delegation.db'),
      });
      const auditLogger = new AuditLogger({ storage: new InMemoryAuditStorage() });
      const approvals = new ApprovalService({
        designatedOwnerId: 'owner_primary',
        auditLogger,
      });
      const container = new ContainerSandboxAdapter({
        dockerCommand: dockerCommand!,
        sandboxRoot: path.join(delegationStateDir, 'sandbox'),
        image: 'node:22-alpine',
      });
      const executionEngine = new AgentExecutionEngine({
        store: execStore,
        approvals,
        auditLogger,
        systemConfig,
        policyConfig: {
          workspaceRoot: process.cwd(),
          allowedRelativePaths: ['sandbox'],
          defaultNetworkMode: 'none',
          defaultBrowserMode: 'disabled',
        },
        adapters: [container],
        defaultSandboxProvider: 'isolated_container_v1',
      });
      const sandboxExecutor = new AgentSandboxExecutor({
        executionEngine,
        providerId: 'isolated_container_v1',
        allowSimulatedProvider: false,
      });
      const delegationEngine = new DelegationEngine({
        store: delegationStore,
        approvals,
        auditLogger,
        systemConfig,
        sandboxExecutor,
        maxConcurrentTasks: 2,
      });
      const created = delegationEngine.createObjective(
        {
          name: 'Real container objective',
          objective:
            'Implement a small tested module in the sandbox and run the allowlisted test suite.',
          context: {
            files: [
              {
                path: 'test.mjs',
                content:
                  "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('objective', () => { assert.equal(7 * 6, 42); });\n",
              },
            ],
            test_command: 'node --test',
          },
        },
        {
          actor: {
            id: 'owner_primary',
            type: 'owner',
            trusted_autonomy_level: 'L4',
            trusted_authenticated: true,
          },
          correlation_id: 'corr_real_objective',
        },
      );
      assert.equal(created.ok, true);
      if (!created.ok) return;

      await delegationEngine.processQueue(20);
      const engineering = delegationEngine
        .listTasks({ projectId: created.data.project.project_id, limit: 100 })
        .find((task) => task.agent_id === 'engineering');
      assert.ok(engineering, 'engineering task should exist');
      assert.equal(engineering!.status, 'COMPLETED');
      const metadata = (engineering!.output?.metadata ?? {}) as Record<string, unknown>;
      const sandboxResult = (metadata.sandbox_result ?? {}) as Record<string, unknown>;
      assert.deepEqual(sandboxResult.changed_files, ['test.mjs']);
      const evidence = engineering!.output?.test_evidence as Record<string, unknown>;
      assert.equal(evidence.executed, true);
      assert.equal(evidence.simulated, false);
      assert.equal(evidence.exit_code, 0);
      assert.match(String(evidence.output), /# pass 1/);
      delegationStore.close();
      execStore.close();
    },
  );
});
