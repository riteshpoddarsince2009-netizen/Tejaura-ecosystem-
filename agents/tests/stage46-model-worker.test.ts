import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import systemConfig from '../../core/configuration/system.json' with { type: 'json' };
import { AuditLogger, InMemoryAuditStorage } from '../../core/audit/index.ts';
import { RuntimeManager } from '../../intelligence/runtime/index.ts';
import {
  AirLlmModelWorker,
  ModelWorkerPool,
  probeWorker,
  type ModelWorkerClient,
} from '../index.ts';

const WORKER_TOKEN = 'stage46-worker-token-never-expose';

async function startMockWorker(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/internal/health') {
        res.end(
          JSON.stringify({
            ok: true,
            engine: 'airllm',
            models: [{ model_name: 'tejaura-reasoning-primary' }],
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/internal/infer') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          model_name?: string;
        };
        res.end(
          JSON.stringify({
            ok: true,
            model_name: body.model_name,
            output_text: `mock local output containing ${WORKER_TOKEN}`,
            finish_reason: 'stop',
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'not found' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind mock worker');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe('TEJAURA Stage 4.6 — AirLLM Worker Integration & Pooling', () => {
  let mock: { url: string; close: () => Promise<void> };
  before(async () => {
    mock = await startMockWorker();
  });
  after(async () => {
    await mock.close();
  });

  it('uses the real RuntimeManager contract for health and inference and redacts worker secrets', async () => {
    const runtime = new RuntimeManager({
      trustedEndpoints: [
        {
          endpoint_id: 'ep-stage46-airllm',
          runtime_type: 'airllm',
          base_url: mock.url,
          node_id: 'node-stage46',
          enabled: true,
          requires_auth: true,
        },
      ],
      authTokenResolver: () => WORKER_TOKEN,
    });
    const auditLogger = new AuditLogger({ storage: new InMemoryAuditStorage() });
    const worker = new AirLlmModelWorker({
      worker_id: 'airllm_stage46_test',
      runtime,
      endpoint: {
        endpoint_id: 'ep-stage46-airllm',
        runtime_type: 'airllm',
        base_url: mock.url,
        node_id: 'node-stage46',
        enabled: true,
        requires_auth: true,
      },
      modelName: 'tejaura-reasoning-primary',
      agent: {
        id: 'ceo_strategy',
        name: 'CEO Strategy Agent',
        department: 'executive',
        role: 'Chief Executive',
        description: 'Test agent',
        status: 'active',
        enabled: true,
        permitted_autonomy_level: 'L2',
        allowed_tool_ids: ['ceo_planner'],
        preferred_model_ids: ['tejaura-reasoning-primary'],
        created_at: '2026-11-24T08:00:00.000Z',
        schema_version: '1.0.0',
      },
      auditLogger,
      systemConfig,
      correlationId: 'corr_stage46_worker_test',
      knownSecretValues: [WORKER_TOKEN],
    });

    const health = await worker.health();
    assert.equal(health.healthy, true);
    assert.equal(health.runtime_type, 'airllm');
    assert.ok(health.models.includes('tejaura-reasoning-primary'));

    const capabilities = await worker.capabilities();
    assert.equal(capabilities.supports_cancellation, true);

    const response = await worker.infer({
      model_name: 'tejaura-reasoning-primary',
      messages: [{ role: 'user', content: 'Return a short plan.' }],
      max_tokens: 64,
    });
    assert.equal(response.ok, true);
    assert.equal(response.untrusted_model_output, true);
    assert.match(response.output_text, /mock local output/);
    assert.ok(!response.output_text.includes(WORKER_TOKEN));
    assert.match(response.output_text, /[REDACTED_SECRET]/);
  });

  it('bounds model worker concurrency and reports pool pressure', async () => {
    const pool = new ModelWorkerPool(2);
    let active = 0;
    let maxActive = 0;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((value) =>
        pool.submit(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return value * 2;
        }),
      ),
    );
    assert.deepEqual(results, [2, 4, 6, 8, 10]);
    assert.equal(maxActive, 2);
    assert.equal(pool.activeJobs, 0);
    assert.equal(pool.queueLength, 0);
  });

  it('reports an unavailable worker without pretending it is healthy', async () => {
    const unhealthy: ModelWorkerClient = {
      worker_id: 'offline_worker',
      runtime_type: 'airllm',
      async health() {
        return {
          healthy: false,
          worker_id: 'offline_worker',
          runtime_type: 'airllm',
          endpoint: 'http://127.0.0.1:1',
          latency_ms: 1,
          models: [],
          error: 'WORKER_UNREACHABLE',
          checked_at: new Date().toISOString(),
        };
      },
      async capabilities() {
        return {
          supports_chat: false,
          supports_completion: false,
          supports_streaming: false,
          supports_cancellation: false,
          supports_tool_calling: false,
          supports_structured_output: false,
          max_context_length: null,
        };
      },
      async infer() {
        return {
          ok: false,
          worker_id: 'offline_worker',
          runtime_type: 'airllm',
          model_name: 'none',
          output_text: '',
          untrusted_model_output: true as const,
          latency_ms: 0,
          error_code: 'WORKER_UNAVAILABLE',
          error: 'Worker is offline.',
        };
      },
    };
    const probe = await probeWorker(unhealthy);
    assert.equal(probe.healthy, false);
    assert.equal(probe.error, 'WORKER_UNREACHABLE');
  });
});
