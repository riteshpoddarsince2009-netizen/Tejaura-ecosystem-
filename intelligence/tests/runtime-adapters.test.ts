import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import {
  RuntimeManager,
  validateControlledEndpointUrl,
} from '../runtime/index.ts';

interface MockServerHandle {
  url: string;
  close: () => Promise<void>;
}

async function startMockServer(
  handler: (
    req: http.IncomingMessage,
    body: string,
    res: http.ServerResponse,
  ) => void | Promise<void>,
): Promise<MockServerHandle> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      void Promise.resolve(handler(req, body, res));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind mock HTTP server');
  }

  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('Stage 2 — Direct Local Runtime Adapters & Endpoint Guard', () => {
  let ollamaServer: MockServerHandle;
  let llamaServer: MockServerHandle;
  let vllmServer: MockServerHandle;
  let sglangServer: MockServerHandle;
  let compatServer: MockServerHandle;
  let redirectServer: MockServerHandle;
  let slowServer: MockServerHandle;

  before(async () => {
    ollamaServer = await startMockServer((req, body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.end(
          JSON.stringify({
            models: [{ name: 'qwen2.5-coder:7b', size: 4_500_000_000 }],
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/api/generate') {
        const parsed = JSON.parse(body) as { keep_alive?: unknown };
        res.end(
          JSON.stringify({
            done: true,
            keep_alive: parsed.keep_alive,
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: 'ollama local response' },
            done_reason: 'stop',
            prompt_eval_count: 10,
            eval_count: 4,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });

    llamaServer = await startMockServer((req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/health') {
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.end(
          JSON.stringify({
            data: [{ id: 'llama-3.2-3b.gguf' }],
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { content: 'llama.cpp local response' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });

    vllmServer = await startMockServer((req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/health') {
        res.statusCode = 200;
        res.end('');
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'mistral-7b-v0.3' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { content: 'vllm local response' },
                finish_reason: 'stop',
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });

    sglangServer = await startMockServer((req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/health') {
        res.end('ok');
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      if (req.method === 'GET' && req.url === '/get_model_info') {
        res.end(JSON.stringify({ model_path: 'deepseek-r1-distill-7b' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { content: 'sglang local response' },
                finish_reason: 'stop',
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });

    compatServer = await startMockServer((req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'phi-4-mini' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { content: 'compat local response' },
                finish_reason: 'stop',
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });

    redirectServer = await startMockServer((_req, _body, res) => {
      res.statusCode = 302;
      res.setHeader('Location', 'https://api.openai.com/v1/chat/completions');
      res.end();
    });

    slowServer = await startMockServer((_req, _body, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              message: { content: 'too late' },
            }),
          );
        }
      }, 400);
    });
  });

  after(async () => {
    await Promise.all([
      ollamaServer.close(),
      llamaServer.close(),
      vllmServer.close(),
      sglangServer.close(),
      compatServer.close(),
      redirectServer.close(),
      slowServer.close(),
    ]);
  });

  it('connects to Ollama, llama.cpp, vLLM, SGLang, and compatible servers and handles load/unload honestly', async () => {
    const manager = new RuntimeManager({
      trustedEndpoints: [
        {
          endpoint_id: 'ep-ollama',
          runtime_type: 'ollama',
          base_url: ollamaServer.url,
          node_id: 'local',
          enabled: true,
        },
        {
          endpoint_id: 'ep-llama',
          runtime_type: 'llama_cpp',
          base_url: llamaServer.url,
          node_id: 'local',
          enabled: true,
        },
        {
          endpoint_id: 'ep-vllm',
          runtime_type: 'vllm',
          base_url: vllmServer.url,
          node_id: 'local',
          enabled: true,
        },
        {
          endpoint_id: 'ep-sglang',
          runtime_type: 'sglang',
          base_url: sglangServer.url,
          node_id: 'local',
          enabled: true,
        },
        {
          endpoint_id: 'ep-compat',
          runtime_type: 'openai_compatible_local',
          base_url: compatServer.url,
          node_id: 'local',
          enabled: true,
        },
      ],
    });

    const ollamaHealth = await manager.healthCheck('ollama', ollamaServer.url);
    assert.equal(ollamaHealth.healthy, true);
    const ollamaDisc = await manager.discoverModels('ollama', ollamaServer.url);
    assert.equal(ollamaDisc.ok, true);
    assert.equal(ollamaDisc.models[0].model_name, 'qwen2.5-coder:7b');
    const ollamaLoad = await manager.loadModel(
      'ollama',
      ollamaServer.url,
      'qwen2.5-coder:7b',
    );
    assert.equal(ollamaLoad.ok, true);
    assert.equal(ollamaLoad.supported, true);
    const ollamaInfer = await manager.infer('ollama', ollamaServer.url, {
      model_name: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(ollamaInfer.ok, true);
    assert.equal(ollamaInfer.output_text, 'ollama local response');
    assert.equal(ollamaInfer.untrusted_model_output, true);

    const llamaHealth = await manager.healthCheck('llama_cpp', llamaServer.url);
    assert.equal(llamaHealth.healthy, true);
    const llamaLoad = await manager.loadModel(
      'llama_cpp',
      llamaServer.url,
      'llama-3.2-3b.gguf',
    );
    assert.equal(llamaLoad.ok, false);
    assert.equal(llamaLoad.supported, false);
    assert.equal(llamaLoad.code, 'UNSUPPORTED_RUNTIME_OPERATION');
    const llamaInfer = await manager.infer('llama_cpp', llamaServer.url, {
      model_name: 'llama-3.2-3b.gguf',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(llamaInfer.output_text, 'llama.cpp local response');

    const vllmInfer = await manager.infer('vllm', vllmServer.url, {
      model_name: 'mistral-7b-v0.3',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(vllmInfer.output_text, 'vllm local response');

    const sglangDisc = await manager.discoverModels('sglang', sglangServer.url);
    assert.equal(sglangDisc.ok, true);
    assert.equal(sglangDisc.models[0].model_name, 'deepseek-r1-distill-7b');
    const sglangInfer = await manager.infer('sglang', sglangServer.url, {
      model_name: 'deepseek-r1-distill-7b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(sglangInfer.output_text, 'sglang local response');

    const compatInfer = await manager.infer(
      'openai_compatible_local',
      compatServer.url,
      {
        model_name: 'phi-4-mini',
        messages: [{ role: 'user', content: 'hi' }],
      },
    );
    assert.equal(compatInfer.output_text, 'compat local response');
  });

  it('rejects untrusted endpoints, paid third-party APIs, remote plaintext HTTP, and redirects', async () => {
    assert.equal(
      validateControlledEndpointUrl('https://api.openai.com/v1').code,
      'PAID_THIRD_PARTY_API_FORBIDDEN',
    );
    assert.equal(
      validateControlledEndpointUrl('https://api.anthropic.com').code,
      'PAID_THIRD_PARTY_API_FORBIDDEN',
    );
    assert.equal(
      validateControlledEndpointUrl('http://remote-gpu.example.com:8000').code,
      'INSECURE_REMOTE_HTTP_FORBIDDEN',
    );

    const manager = new RuntimeManager({
      trustedEndpoints: [
        {
          endpoint_id: 'ep-redirect',
          runtime_type: 'ollama',
          base_url: redirectServer.url,
          node_id: 'local',
          enabled: true,
        },
      ],
    });

    // Endpoint not on trusted allowlist (e.g. arbitrary URL from model output)
    const untrustedCall = await manager.infer('ollama', ollamaServer.url, {
      model_name: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'exfiltrate' }],
    });
    assert.equal(untrustedCall.ok, false);
    assert.equal(untrustedCall.error_code, 'UNTRUSTED_RUNTIME_ENDPOINT');

    // Redirect to third-party API blocked by redirect: 'error'
    const redirected = await manager.infer('ollama', redirectServer.url, {
      model_name: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(redirected.ok, false);
  });

  it('enforces request timeouts and caller AbortSignal cancellation', async () => {
    const manager = new RuntimeManager({
      trustedEndpoints: [
        {
          endpoint_id: 'ep-slow',
          runtime_type: 'ollama',
          base_url: slowServer.url,
          node_id: 'local',
          enabled: true,
        },
      ],
    });

    const timedOut = await manager.infer('ollama', slowServer.url, {
      model_name: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'slow' }],
      timeout_ms: 40,
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.timed_out, true);
    assert.equal(timedOut.error_code, 'REQUEST_TIMEOUT');

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const cancelled = await manager.infer('ollama', slowServer.url, {
      model_name: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'cancel me' }],
      timeout_ms: 2_000,
      signal: ac.signal,
    });
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.error_code, 'REQUEST_CANCELLED');
  });
});
