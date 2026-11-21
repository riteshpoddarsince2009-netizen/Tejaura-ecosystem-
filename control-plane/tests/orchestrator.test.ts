import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { AuditLogger, InMemoryAuditStorage } from '../../core/audit/index.ts';
import systemConfig from '../../core/configuration/system.json' with { type: 'json' };
import type { PolicyActor } from '../../core/policy/index.ts';
import { HardwareManager, type ComputeNode } from '../../intelligence/hardware/index.ts';
import { ModelLifecycleManager } from '../../intelligence/lifecycle/index.ts';
import localModelsBaseline from '../../intelligence/model-registry/local-models.json' with { type: 'json' };
import {
  LocalModelRegistry,
  type LocalModelEntry,
  type LocalModelRegistryDocument,
} from '../../intelligence/model-registry/local-model-registry.ts';
import { ModelRouter } from '../../intelligence/router/index.ts';
import { RuntimeManager } from '../../intelligence/runtime/index.ts';
import { SqliteOrchestrationStore } from '../db/index.ts';
import { TaskOrchestrator } from '../orchestrator/index.ts';

function makeClock(startIso = '2026-11-20T12:00:00.000Z') {
  let ms = new Date(startIso).getTime();
  return {
    now: () => new Date(ms),
    advanceMs: (delta: number) => {
      ms += delta;
    },
  };
}

function ownerActor(id = 'owner_primary'): PolicyActor {
  return {
    id,
    type: 'owner',
    trusted_autonomy_level: 'L4',
    trusted_authenticated: true,
  };
}

function agentActor(id = 'agent_planner'): PolicyActor {
  return {
    id,
    type: 'agent',
    trusted_autonomy_level: 'L3',
    trusted_authenticated: true,
  };
}

function buildAirLlmEntry(endpoint: string): LocalModelEntry {
  return {
    model_id: 'llama-3.1-70b-airllm',
    model_name: 'Meta-Llama-3.1-70B-Instruct',
    model_family: 'llama3.1',
    model_version: '70b-instruct',
    model_repository: {
      repo_id: 'meta-llama/Llama-3.1-70B-Instruct',
      revision: 'main',
      source: 'local_mirror',
    },
    local_model_path: 'models/llama-3.1-70b-instruct',
    controlled_runtime_endpoint: endpoint,
    runtime_type: 'airllm',
    compatibility_status: 'verified',
    modality: 'text',
    capabilities: ['chat', 'text_generation', 'reasoning'],
    hardware_requirements: {
      min_ram_mb: 16384,
      min_vram_mb: 4096,
      min_storage_mb: 45000,
      requires_gpu: true,
    },
    quantization: '4bit',
    context_length: 32768,
    enabled: true,
    availability: 'available',
    license: {
      name: 'Llama 3.1 Community License',
      open_weight: true,
      commercial_use_allowed: true,
    },
  };
}

function buildNode(): ComputeNode {
  return {
    node_id: 'node-owner-gpu',
    name: 'Owner Desktop 8GB GPU',
    location: 'lan',
    total_ram_mb: 32768,
    available_ram_mb: 24576,
    total_vram_mb: 8192,
    available_vram_mb: 6144,
    total_storage_mb: 1_000_000,
    available_storage_mb: 400_000,
    has_gpu: true,
    gpu_name: 'RTX 4060 8GB',
    supported_runtimes: ['airllm', 'ollama'],
    installed_model_ids: ['llama-3.1-70b-airllm'],
    online: true,
    last_seen_at: '2026-11-20T12:00:00Z',
  };
}

async function startMockAirLlmServer(expectedToken: string) {
  let loadedModel = false;
  const server = http.createServer((req, res) => {
    const authHeader = req.headers['x-tejaura-worker-token'];
    if (authHeader !== expectedToken) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized worker token' }));
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/internal/health' && req.method === 'GET') {
      res.end(JSON.stringify({ ok: true, status: 'ok', engine: 'airllm', loaded: loadedModel }));
      return;
    }
    if (req.url === '/internal/models' && req.method === 'GET') {
      res.end(
        JSON.stringify({
          models: [
            {
              model_id: 'llama-3.1-70b-airllm',
              model_name: 'Meta-Llama-3.1-70B-Instruct',
              loaded: loadedModel,
            },
          ],
        }),
      );
      return;
    }
    if (req.url === '/internal/models/load' && req.method === 'POST') {
      loadedModel = true;
      res.end(JSON.stringify({ ok: true, status: 'loaded', runtime_type: 'airllm' }));
      return;
    }
    if (req.url === '/internal/models/unload' && req.method === 'POST') {
      loadedModel = false;
      res.end(JSON.stringify({ ok: true, status: 'unloaded', runtime_type: 'airllm' }));
      return;
    }
    if (req.url === '/internal/infer' && req.method === 'POST') {
      res.end(
        JSON.stringify({
          ok: true,
          output_text: 'Local AirLLM verified response.',
          finish_reason: 'stop',
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind mock AirLLM worker');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function createHarness(options: {
  dbPath: string;
  clock?: () => Date;
  airllmEndpoint?: string;
  workerToken?: string;
  leaseDurationMs?: number;
}) {
  const store = new SqliteOrchestrationStore({ dbPath: options.dbPath });
  const auditLogger = new AuditLogger({
    storage: new InMemoryAuditStorage(),
    clock: options.clock,
  });

  const baseDoc = structuredClone(localModelsBaseline) as LocalModelRegistryDocument;
  if (options.airllmEndpoint) {
    baseDoc.models = [buildAirLlmEntry(options.airllmEndpoint)];
  }
  const registry = new LocalModelRegistry(baseDoc);
  const hardware = new HardwareManager([buildNode()]);
  const runtime = new RuntimeManager({
    trustedEndpoints: options.airllmEndpoint
      ? [
          {
            endpoint_id: 'ep-airllm-test',
            runtime_type: 'airllm',
            base_url: options.airllmEndpoint,
            node_id: 'node-owner-gpu',
            enabled: true,
            requires_auth: true,
            auth_token_env_var: 'TEJAURA_AIRLLM_WORKER_TOKEN',
          },
        ]
      : [],
    authTokenResolver: () => options.workerToken,
  });
  const lifecycle = new ModelLifecycleManager({ registry, hardware, runtime });
  const router = new ModelRouter({ registry, hardware, lifecycle, runtime });

  const orchestrator = new TaskOrchestrator({
    store,
    designatedOwnerId: 'owner_primary',
    systemConfig,
    auditLogger,
    registry,
    hardware,
    lifecycle,
    runtime,
    router,
    leaseDurationMs: options.leaseDurationMs ?? 30_000,
    clock: options.clock,
  });

  return { store, orchestrator, auditLogger };
}

describe('Stage 3 — SQLite Persistence & TaskOrchestrator Governance', () => {
  const tempRoots: string[] = [];

  function makeDbPath(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-stage3-orch-'));
    tempRoots.push(dir);
    return path.join(dir, `${name}.db`);
  }

  after(() => {
    for (const dir of tempRoots) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists tasks, events, attempts, and approvals across SQLite reopen and recovers abandoned leases safely', async () => {
    const clock = makeClock();
    const dbPath = makeDbPath('restart-recovery');
    const h1 = createHarness({
      dbPath,
      clock: clock.now,
      leaseDurationMs: 5_000,
    });

    // 1. Idempotent task that crashes mid-lease -> should be safely requeued on restart
    const idemSub = h1.orchestrator.submitTask(
      {
        type: 'governance.read',
        title: 'Inventory snapshot',
        description: 'Inspect local models and compute nodes.',
        action: 'governance:read',
        resource_id: 'system:inventory',
        environment: 'local',
        autonomy_level: 'L0',
        declared_scopes: ['governance:read'],
        priority: 70,
        idempotent_action: true,
        max_retries: 2,
        input: {},
      },
      { actor: ownerActor(), correlation_id: 'corr_idem_1' },
    );
    assert.equal(idemSub.ok, true);

    // Manually lease it to simulate an abrupt process crash before completion.
    const leased1 = h1.store.acquireNextTaskLease({
      workerId: 'crashed-worker-1',
      leaseToken: 'lease-crashed-1',
      leaseDurationMs: 5_000,
      maxConcurrentRunning: 2,
      nowIso: clock.now().toISOString(),
    });
    assert.ok(leased1);
    assert.equal(leased1.task.id, idemSub.task.id);

    // 2. Non-idempotent external task where external effect WAS dispatched before crash -> must NOT auto-retry
    const nonIdemSub = h1.orchestrator.submitTask(
      {
        type: 'external.api_call',
        title: 'Dispatch non-idempotent webhook',
        description: 'Deliver webhook notification.',
        action: 'external:api_call',
        resource_id: 'webhook:staging',
        environment: 'staging',
        autonomy_level: 'L3',
        declared_scopes: ['net:egress:approved'],
        priority: 80,
        idempotent_action: false,
        max_retries: 2,
        input: {},
      },
      { actor: ownerActor(), correlation_id: 'corr_nonidem_1' },
    );
    assert.equal(nonIdemSub.ok, true);
    assert.ok(nonIdemSub.approval_id);
    assert.equal(nonIdemSub.task.status, 'waiting_for_approval');

    const approveRes = h1.orchestrator.decideApprovalAndResumeTask({
      approval_id: nonIdemSub.approval_id,
      decision: 'approved',
      reviewer: {
        actor_id: 'owner_primary',
        actor_type: 'owner',
        authenticated: true,
        auth_source: 'session-test',
      },
      reason: 'Verified webhook endpoint in staging',
      correlation_id: 'corr_approve_nonidem',
    });
    assert.equal(approveRes.ok, true);

    const leased2 = h1.store.acquireNextTaskLease({
      workerId: 'crashed-worker-2',
      leaseToken: 'lease-crashed-2',
      leaseDurationMs: 5_000,
      maxConcurrentRunning: 4,
      nowIso: clock.now().toISOString(),
    });
    assert.ok(leased2);
    h1.store.markExternalEffectDispatched(leased2.attempt.attempt_id, 'lease-crashed-2');

    // Close DB to simulate process exit
    h1.store.close();

    // Advance clock past 5s lease expiry and reopen in new orchestrator instance
    clock.advanceMs(10_000);
    const h2 = createHarness({ dbPath, clock: clock.now });
    const recovery = h2.orchestrator.recoverOnStartup();
    assert.equal(recovery.recovered_count, 2);

    const idemDetailAfterRecover = h2.orchestrator.getTaskDetail(idemSub.task.id)!;
    assert.equal(idemDetailAfterRecover.task.status, 'queued');
    assert.equal(idemDetailAfterRecover.attempts[0]?.status, 'abandoned');

    const nonIdemAfterRecover = h2.orchestrator.getTaskDetail(nonIdemSub.task.id)!;
    assert.equal(nonIdemAfterRecover.task.status, 'failed');
    assert.equal(
      nonIdemAfterRecover.task.error?.code,
      'NON_IDEMPOTENT_STATE_UNCERTAIN',
    );

    // Attempting manual retry without explicit confirmation must fail closed
    const blockedRetry = h2.orchestrator.retryTask({
      taskId: nonIdemSub.task.id,
      actor: ownerActor(),
      confirmNonIdempotentRetry: false,
      correlation_id: 'corr_retry_blocked',
    });
    assert.equal(blockedRetry.ok, false);
    assert.equal(blockedRetry.code, 'NON_IDEMPOTENT_CONFIRMATION_REQUIRED');

    // Explicit owner confirmation unlocks retry
    const confirmedRetry = h2.orchestrator.retryTask({
      taskId: nonIdemSub.task.id,
      actor: ownerActor(),
      confirmNonIdempotentRetry: true,
      correlation_id: 'corr_retry_confirmed',
    });
    assert.equal(confirmedRetry.ok, true);
    assert.equal(confirmedRetry.task.status, 'queued');

    // Worker tick executes the recovered idempotent task cleanly
    const tick = await h2.orchestrator.runWorkerTick();
    assert.equal(tick.task_executed, true);
    h2.store.close();
  });

  it('enforces idempotency deduplication, priority order, governance self-approval guard, and cancellation', async () => {
    const clock = makeClock();
    const dbPath = makeDbPath('governance-priority');
    const h = createHarness({ dbPath, clock: clock.now });

    // Agent cannot submit L4 / owner-exclusive deploy:production
    const deniedL4 = h.orchestrator.submitTask(
      {
        type: 'deploy.production',
        title: 'Unauthorized prod deploy',
        description: 'Attempt prod deployment by agent.',
        action: 'deploy:production',
        resource_id: 'prod:cluster-1',
        environment: 'production',
        autonomy_level: 'L4',
        declared_scopes: ['deploy:production'],
        input: {},
      },
      { actor: agentActor('agent_rogue'), correlation_id: 'corr_l4_deny' },
    );
    assert.equal(deniedL4.ok, false);

    // Agent submits L3 action -> enters waiting_for_approval and blocks agent self-approval
    const agentL3 = h.orchestrator.submitTask(
      {
        type: 'external.api_call',
        title: 'Call approved endpoint',
        description: 'Fetch weather status.',
        action: 'external:api_call',
        resource_id: 'endpoint:status',
        environment: 'staging',
        autonomy_level: 'L3',
        declared_scopes: ['net:egress:approved'],
        input: {},
      },
      { actor: agentActor('agent_worker_1'), correlation_id: 'corr_l3_agent' },
    );
    assert.equal(agentL3.ok, true);
    assert.ok(agentL3.approval_id);

    const selfApproveAttempt = h.orchestrator.decideApprovalAndResumeTask({
      approval_id: agentL3.approval_id,
      decision: 'approved',
      reviewer: {
        actor_id: 'agent_worker_1',
        actor_type: 'agent',
        authenticated: true,
        auth_source: 'agent-test',
      },
      reason: 'Trying self approval',
      correlation_id: 'corr_self_approve',
    });
    assert.equal(selfApproveAttempt.ok, false);
    assert.equal(selfApproveAttempt.code, 'AGENT_APPROVAL_FORBIDDEN');

    // Owner rejection cancels awaiting task
    const rejectAttempt = h.orchestrator.decideApprovalAndResumeTask({
      approval_id: agentL3.approval_id,
      decision: 'rejected',
      reviewer: {
        actor_id: 'owner_primary',
        actor_type: 'owner',
        authenticated: true,
        auth_source: 'session-test',
      },
      reason: 'Endpoint maintenance window active',
      correlation_id: 'corr_owner_reject',
    });
    assert.equal(rejectAttempt.ok, true);
    assert.equal(rejectAttempt.task?.status, 'cancelled');

    // Idempotency key deduplicates second submission
    const lowPri = h.orchestrator.submitTask(
      {
        type: 'governance.read',
        title: 'Low priority read',
        description: 'Inspect state at low priority.',
        action: 'governance:read',
        resource_id: 'system:inventory',
        environment: 'local',
        autonomy_level: 'L0',
        declared_scopes: ['governance:read'],
        priority: 10,
        idempotency_key: 'idem-read-low-1',
        input: {},
      },
      { actor: ownerActor(), correlation_id: 'corr_low_1' },
    );
    assert.equal(lowPri.ok, true);
    assert.equal(lowPri.duplicate, false);

    const dup = h.orchestrator.submitTask(
      {
        type: 'governance.read',
        title: 'Low priority read duplicate',
        description: 'Duplicate request.',
        action: 'governance:read',
        resource_id: 'system:inventory',
        environment: 'local',
        autonomy_level: 'L0',
        declared_scopes: ['governance:read'],
        priority: 99,
        idempotency_key: 'idem-read-low-1',
        input: {},
      },
      { actor: ownerActor(), correlation_id: 'corr_low_dup' },
    );
    assert.equal(dup.ok, true);
    assert.equal(dup.duplicate, true);
    assert.equal(dup.task.id, lowPri.task.id);

    const highPri = h.orchestrator.submitTask(
      {
        type: 'governance.read',
        title: 'High priority read',
        description: 'Inspect state urgently.',
        action: 'governance:read',
        resource_id: 'system:inventory',
        environment: 'local',
        autonomy_level: 'L0',
        declared_scopes: ['governance:read'],
        priority: 95,
        input: {},
      },
      { actor: ownerActor(), correlation_id: 'corr_high_1' },
    );
    assert.equal(highPri.ok, true);

    // High-priority task must execute first
    const tick1 = await h.orchestrator.runWorkerTick();
    assert.equal(tick1.task_executed, true);
    assert.equal(tick1.executed_task_id, highPri.task.id);
    assert.equal(tick1.executed_status, 'succeeded');

    // Cancel remaining queued low-priority task
    const cancelRes = h.orchestrator.cancelTask({
      taskId: lowPri.task.id,
      actor: ownerActor(),
      reason: 'No longer needed',
      correlation_id: 'corr_cancel_low',
    });
    assert.equal(cancelRes.ok, true);
    assert.equal(cancelRes.task.status, 'cancelled');

    h.store.close();
  });

  it('executes scheduled tasks and AirLLM primary inference tasks without paid API fallback', async () => {
    const clock = makeClock();
    const workerToken = 'synthetic-airllm-worker-token-test';
    const worker = await startMockAirLlmServer(workerToken);

    try {
      const dbPath = makeDbPath('airllm-schedules');
      const h = createHarness({
        dbPath,
        clock: clock.now,
        airllmEndpoint: worker.url,
        workerToken,
      });

      // Schedule recurring task (triggers on clock advance)
      const schedRes = h.orchestrator.createSchedule(
        {
          name: 'Recurring AirLLM Prompt Check',
          description: 'Periodic local AirLLM inference smoke check.',
          interval_seconds: 60,
          task_template: {
            type: 'model.invoke_local',
            title: 'Local AirLLM Ping',
            description: 'Respond with verification message.',
            action: 'model:invoke_local',
            resource_id: 'model:llama-3.1-70b-airllm',
            environment: 'local',
            autonomy_level: 'L2',
            declared_scopes: ['model:invoke:local'],
            priority: 65,
            idempotent_action: true,
            max_retries: 1,
            timeout_ms: 10_000,
            input: { prompt: 'Summarize local node readiness.' },
          },
        },
        ownerActor(),
        'corr_sched_1',
      );
      assert.equal(schedRes.ok, true);

      // Before interval elapses, 0 schedules trigger
      const earlyTick = await h.orchestrator.runWorkerTick();
      assert.equal(earlyTick.schedules_triggered, 0);
      assert.equal(earlyTick.task_executed, false);

      // Advance clock 65s -> triggers schedule & executes task through AirLLM worker
      clock.advanceMs(65_000);
      const dueTick = await h.orchestrator.runWorkerTick();
      assert.equal(dueTick.schedules_triggered, 1);
      assert.equal(dueTick.task_executed, true);
      assert.equal(dueTick.executed_status, 'succeeded');

      const detail = h.orchestrator.getTaskDetail(dueTick.executed_task_id!)!;
      assert.equal(detail.task.result?.paid_api_fallback_used, false);
      assert.equal(detail.task.result?.output_text, 'Local AirLLM verified response.');
      assert.equal(detail.attempts[0]?.runtime_type, 'airllm');
      assert.equal(detail.attempts[0]?.model_id, 'llama-3.1-70b-airllm');

      h.store.close();
    } finally {
      await worker.close();
    }
  });
});
