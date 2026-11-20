import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import systemConfig from '../../core/configuration/system.json' with { type: 'json' };
import {
  ApprovalService,
  toContractApproval,
} from '../../core/approvals/index.ts';
import { AuditLogger, InMemoryAuditStorage } from '../../core/audit/index.ts';
import { HardwareManager, type ComputeNode } from '../hardware/index.ts';
import { ModelLifecycleManager } from '../lifecycle/index.ts';
import localModelsBaseline from '../model-registry/local-models.json' with { type: 'json' };
import {
  LocalModelRegistry,
  type LocalModelEntry,
} from '../model-registry/local-model-registry.ts';
import { ModelRouter } from '../router/index.ts';
import {
  PRIMARY_LOCAL_RUNTIME,
  RuntimeManager,
} from '../runtime/index.ts';

function makeAirLlmModel(
  id: string,
  endpoint: string,
  overrides: Partial<LocalModelEntry> = {},
): LocalModelEntry {
  return {
    model_id: id,
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
    ...overrides,
  };
}

function makeComputeNode(overrides: Partial<ComputeNode> = {}): ComputeNode {
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
    ...overrides,
  };
}

async function startPythonMockWorker(
  token: string,
  delayMs = 0,
): Promise<{ url: string; close: () => Promise<void> }> {
  const proc: ChildProcessWithoutNullStreams = spawn(
    'python3',
    [
      'workers/airllm/server.py',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--mode',
      'mock',
      '--mock-delay-ms',
      String(delayMs),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEJAURA_AIRLLM_WORKER_TOKEN: token,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  const url = await new Promise<string>((resolve, reject) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timed out waiting for Python worker startup. stderr=${stderrBuf}`));
    }, 5_000);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(stdoutBuf);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Python worker exited prematurely (${code}): ${stderrBuf}`));
    });
  });

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
          resolve();
        }, 1_000);
      }),
  };
}

describe('Stage 2A — AirLLM Primary Runtime & Python Worker Integration', () => {
  const workerToken = 'stage2a-internal-worker-token-secret';
  let fastWorker: { url: string; close: () => Promise<void> };
  let slowWorker: { url: string; close: () => Promise<void> };
  let ollamaStub: { url: string; close: () => Promise<void> };

  before(async () => {
    fastWorker = await startPythonMockWorker(workerToken, 10);
    slowWorker = await startPythonMockWorker(workerToken, 300);

    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }));
        return;
      }
      if (req.url === '/api/chat') {
        res.end(JSON.stringify({ message: { content: 'ollama secondary' } }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind ollama stub');
    ollamaStub = {
      url: `http://127.0.0.1:${addr.port}`,
      close: () =>
        new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        ),
    };
  });

  after(async () => {
    await Promise.all([fastWorker.close(), slowWorker.close(), ollamaStub.close()]);
  });

  it('connects TypeScript RuntimeManager to the authenticated Python AirLLM worker for health, load, discovery, inference, and unload', async () => {
    assert.equal(PRIMARY_LOCAL_RUNTIME, 'airllm');

    const runtime = new RuntimeManager({
      trustedEndpoints: [
        {
          endpoint_id: 'ep-airllm-primary',
          runtime_type: 'airllm',
          base_url: fastWorker.url,
          node_id: 'node-owner-gpu',
          enabled: true,
          requires_auth: true,
        },
      ],
      authTokenResolver: () => workerToken,
    });

    const health = await runtime.healthCheck('airllm', fastWorker.url);
    assert.equal(health.healthy, true);
    assert.equal(health.details?.engine, 'airllm');

    const load = await runtime.loadModel(
      'airllm',
      fastWorker.url,
      'Meta-Llama-3.1-70B-Instruct',
      {
        metadata: {
          model_id: 'llama-3.1-70b-airllm',
          repo_id: 'meta-llama/Llama-3.1-70B-Instruct',
          revision: 'main',
          compatibility_status: 'verified',
          modality: 'text',
          compression: '4bit',
        },
      },
    );
    assert.equal(load.ok, true);
    assert.equal(load.supported, true);

    const discovery = await runtime.discoverModels('airllm', fastWorker.url);
    assert.equal(discovery.ok, true);
    assert.equal(discovery.models[0].model_name, 'Meta-Llama-3.1-70B-Instruct');

    const infer = await runtime.infer('airllm', fastWorker.url, {
      model_name: 'Meta-Llama-3.1-70B-Instruct',
      compatibility_status: 'verified',
      modality: 'text',
      messages: [{ role: 'user', content: 'Verify AirLLM pipeline' }],
    });
    assert.equal(infer.ok, true);
    assert.equal(infer.untrusted_model_output, true);
    assert.match(infer.output_text, /Verify AirLLM pipeline/);

    const unload = await runtime.unloadModel(
      'airllm',
      fastWorker.url,
      'Meta-Llama-3.1-70B-Instruct',
    );
    assert.equal(unload.ok, true);
  });

  it('fails closed on missing/invalid worker auth, timeouts, and AbortSignal cancellation', async () => {
    const unauthenticatedRuntime = new RuntimeManager({
      trustedEndpoints: [
        {
          endpoint_id: 'ep-airllm-noauth',
          runtime_type: 'airllm',
          base_url: fastWorker.url,
          node_id: 'node-owner-gpu',
          enabled: true,
        },
      ],
    });
    const prevEnv = process.env.TEJAURA_AIRLLM_WORKER_TOKEN;
    delete process.env.TEJAURA_AIRLLM_WORKER_TOKEN;

    try {
      const missingAuth = await unauthenticatedRuntime.healthCheck(
        'airllm',
        fastWorker.url,
      );
      assert.equal(missingAuth.healthy, false);
      assert.match(missingAuth.error ?? '', /MISSING_WORKER_AUTH_TOKEN/);
    } finally {
      if (prevEnv !== undefined) process.env.TEJAURA_AIRLLM_WORKER_TOKEN = prevEnv;
    }

    const wrongAuthRuntime = new RuntimeManager({
      trustedEndpoints: [
        {
          endpoint_id: 'ep-airllm-badauth',
          runtime_type: 'airllm',
          base_url: fastWorker.url,
          node_id: 'node-owner-gpu',
          enabled: true,
        },
      ],
      authTokenResolver: () => 'wrong-token-value',
    });
    const unauthorized = await wrongAuthRuntime.healthCheck(
      'airllm',
      fastWorker.url,
    );
    assert.equal(unauthorized.healthy, false);
    assert.match(unauthorized.error ?? '', /UNAUTHORIZED/);

    const slowRuntime = new RuntimeManager({
      trustedEndpoints: [
        {
          endpoint_id: 'ep-airllm-slow',
          runtime_type: 'airllm',
          base_url: slowWorker.url,
          node_id: 'node-owner-gpu',
          enabled: true,
        },
      ],
      authTokenResolver: () => workerToken,
    });

    const timedOut = await slowRuntime.infer('airllm', slowWorker.url, {
      model_name: 'Meta-Llama-3.1-70B-Instruct',
      compatibility_status: 'verified',
      modality: 'text',
      messages: [{ role: 'user', content: 'timeout test' }],
      timeout_ms: 40,
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.timed_out, true);
    assert.equal(timedOut.error_code, 'REQUEST_TIMEOUT');

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const cancelled = await slowRuntime.infer('airllm', slowWorker.url, {
      model_name: 'Meta-Llama-3.1-70B-Instruct',
      compatibility_status: 'verified',
      modality: 'text',
      messages: [{ role: 'user', content: 'cancel test' }],
      timeout_ms: 2_000,
      signal: ac.signal,
    });
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.error_code, 'REQUEST_CANCELLED');
  });

  it('prefers AirLLM as primary runtime in ModelRouter and fails closed on untested, unsupported, or non-text models', async () => {
    let seq = 0;
    const now = new Date('2026-11-20T12:00:00Z');
    const auditLogger = new AuditLogger({
      storage: new InMemoryAuditStorage(),
      clock: () => now,
      idGenerator: () => `evt_${++seq}`,
    });
    const approvalService = new ApprovalService({
      designatedOwnerId: 'owner:primary',
      auditLogger,
      clock: () => now,
      idGenerator: () => `apr_${++seq}`,
    });

    const registry = new LocalModelRegistry(localModelsBaseline as never);
    const ownerCtx = {
      actor: {
        id: 'owner:primary',
        type: 'owner' as const,
        trusted_autonomy_level: 'L4' as const,
        trusted_authenticated: true,
      },
      declared_scopes: ['model:registry:write'],
      system_config: systemConfig,
      audit_logger: auditLogger,
      correlation_id: 'corr_airllm_route',
    };

    // Register secondary Ollama model and primary AirLLM model with matching capabilities
    registry.registerModel(
      makeAirLlmModel('ollama-secondary-7b', ollamaStub.url, {
        model_name: 'qwen2.5:7b',
        runtime_type: 'ollama',
        quantization: 'Q4_K_M',
        compatibility_status: 'verified',
      }),
      ownerCtx,
    );
    registry.registerModel(
      makeAirLlmModel('airllm-primary-70b', fastWorker.url, {
        runtime_type: 'airllm',
        compatibility_status: 'verified',
      }),
      ownerCtx,
    );
    // Register disabled untested model
    registry.registerModel(
      makeAirLlmModel('airllm-untested-405b', fastWorker.url, {
        compatibility_status: 'untested',
        enabled: false,
      }),
      ownerCtx,
    );

    const hardware = new HardwareManager([makeComputeNode()]);
    const runtime = new RuntimeManager({
      trustedEndpoints: [
        {
          endpoint_id: 'ep-airllm',
          runtime_type: 'airllm',
          base_url: fastWorker.url,
          node_id: 'node-owner-gpu',
          enabled: true,
        },
        {
          endpoint_id: 'ep-ollama',
          runtime_type: 'ollama',
          base_url: ollamaStub.url,
          node_id: 'node-owner-gpu',
          enabled: true,
        },
      ],
      authTokenResolver: () => workerToken,
    });
    const lifecycle = new ModelLifecycleManager({
      registry,
      hardware,
      runtime,
    });
    const router = new ModelRouter({
      registry,
      hardware,
      lifecycle,
      runtime,
    });

    // 1. AirLLM wins as primary default runtime when no override is passed
    const primaryDecision = router.route({
      task_id: 'task_primary_1',
      required_capabilities: ['chat', 'reasoning'],
      min_context_length: 8192,
      priority: 'normal',
    });
    assert.equal(primaryDecision.decision, 'routed');
    assert.equal(primaryDecision.selected_model?.model_id, 'airllm-primary-70b');
    assert.equal(primaryDecision.selected_model?.runtime_type, 'airllm');
    assert.equal(primaryDecision.paid_api_fallback_used, false);

    // 2. Vision / image capabilities have no verified AirLLM execution path -> unavailable (never paid API)
    const visionDecision = router.route({
      task_id: 'task_vision_blocked',
      required_capabilities: ['vision'],
      min_context_length: 4096,
      priority: 'high',
    });
    assert.equal(visionDecision.decision, 'unavailable');
    assert.equal(visionDecision.paid_api_fallback_used, false);

    // 3. Lifecycle refuses untested models
    const untestedAvail = await lifecycle.checkAvailability(
      'airllm-untested-405b',
    );
    assert.equal(untestedAvail.available, false);

    // 4. Rejects literal secret in auth_token_env_var when registering AirLLM endpoint
    const reqApproval = approvalService.requestApproval({
      task_id: 'task_bad_env',
      action: 'runtime:manage',
      requested_by: 'agent_ops',
      environment: 'local',
      reason: 'Register endpoint',
      scope: {
        resources: ['runtime:ep-bad-env'],
        permissions: ['runtime:manage:approved'],
        single_use: true,
        expires_at: '2026-11-20T13:00:00Z',
      },
      correlation_id: 'corr_bad_env',
    });
    assert.equal(reqApproval.ok, true);
    if (!reqApproval.ok) return;
    const approved = approvalService.decideApproval({
      approval_id: reqApproval.record.id,
      decision: 'approved',
      reviewer: {
        actor_id: 'owner:primary',
        actor_type: 'owner',
        authenticated: true,
        auth_source: 'external-session',
      },
      reason: 'Check env var guard',
      correlation_id: 'corr_bad_env',
    });
    assert.equal(approved.ok, true);
    if (!approved.ok) return;

    const secretInEnvField = runtime.registerTrustedEndpoint(
      {
        endpoint_id: 'ep-bad-env',
        runtime_type: 'airllm',
        base_url: 'http://127.0.0.1:8765',
        node_id: 'node-owner-gpu',
        enabled: true,
        auth_token_env_var: 'sk-literal-secret-value',
      },
      {
        actor: {
          id: 'agent_ops',
          type: 'agent',
          trusted_autonomy_level: 'L3',
        },
        declared_scopes: ['runtime:manage:approved'],
        environment: 'local',
        system_config: systemConfig,
        audit_logger: auditLogger,
        correlation_id: 'corr_bad_env',
        approval: toContractApproval(approved.record),
        now,
      },
    );
    assert.equal(secretInEnvField.ok, false);
    assert.equal(secretInEnvField.code, 'INVALID_AUTH_TOKEN_ENV_VAR');
  });
});
