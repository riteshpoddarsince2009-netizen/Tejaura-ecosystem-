import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { Approval } from '../../contracts/types/index.ts';
import { AuditLogger, InMemoryAuditStorage } from '../../core/audit/index.ts';
import {
  invokeModelThroughGateway,
  type GatewayPolicyContext,
  type SecretResolver,
} from '../gateway/index.ts';
import { loadModelRegistry } from '../model-registry/registry-loader.ts';
import type { ModelRegistry } from '../model-registry/validate-model-registry.ts';
import {
  MockModelAdapter,
  OpenAICompatibleLocalAdapter,
  type FetchLike,
} from '../providers/index.ts';

const SYSTEM_CONFIG = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), 'core/configuration/system.json'),
    'utf8',
  ),
);

const FIXED_NOW = '2026-11-20T12:00:00Z';

function createSampleRegistry(
  models: ModelRegistry['models'],
  defaultModelId: string | null = null,
): ModelRegistry {
  return {
    schemaVersion: '1.0.0',
    registryVersion: '0.2.0',
    lastUpdated: FIXED_NOW,
    policy: {
      providerAgnostic: true,
      openSourceFirst: true,
      freeFirst: true,
      allowSecretsInRegistry: false,
      requireExplicitOwnerRegistration: true,
    },
    defaultModelId,
    providers: [],
    models,
  };
}

function createLocalPolicyContext(
  overrides: Partial<GatewayPolicyContext> = {},
): GatewayPolicyContext {
  return {
    actor: {
      id: 'agent_planner',
      type: 'agent',
      trusted_autonomy_level: 'L2',
    },
    environment: 'local',
    declared_scopes: ['model:invoke:local'],
    approval: null,
    system_config: SYSTEM_CONFIG,
    now: FIXED_NOW,
    ...overrides,
  };
}

function createRemoteApproval(modelId: string): Approval {
  return {
    id: 'apr_remote_01',
    task_id: 'task_remote_01',
    action: 'model:invoke_remote',
    requested_by: 'agent_planner',
    requested_at: '2026-11-20T11:50:00Z',
    status: 'approved',
    reviewed_by: 'owner:primary',
    reviewed_at: '2026-11-20T11:55:00Z',
    reason: 'Approved remote inference for staging evaluation.',
    environment: 'staging',
    scope: {
      resources: [`model:${modelId}`],
      permissions: ['model:invoke:remote'],
      single_use: true,
      expires_at: '2026-11-20T13:00:00Z',
    },
  };
}

describe('Stage 2 — Model Registry Loader', () => {
  it('loads a valid registry and filters strictly to enabled models', () => {
    const registry = createSampleRegistry(
      [
        {
          id: 'local-llama-enabled',
          displayName: 'Local Llama Enabled',
          providerType: 'local-open-source',
          adapter: 'mock',
          endpoint: 'http://localhost:11434/v1',
          apiKeyEnvVar: null,
          license: 'open-weights',
          costTier: 'free',
          capabilities: ['text-generation', 'reasoning'],
          contextWindow: 8192,
          maxAutonomyAllowed: 'L2',
          enabled: true,
          addedAt: FIXED_NOW,
        },
        {
          id: 'local-llama-disabled',
          displayName: 'Local Llama Disabled',
          providerType: 'local-open-source',
          adapter: 'mock',
          endpoint: 'http://localhost:11434/v1',
          apiKeyEnvVar: null,
          license: 'open-weights',
          costTier: 'free',
          capabilities: ['text-generation'],
          contextWindow: 8192,
          maxAutonomyAllowed: 'L2',
          enabled: false,
          addedAt: FIXED_NOW,
        },
      ],
      'local-llama-enabled',
    );

    const loaded = loadModelRegistry(registry);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    assert.equal(loaded.data.enabledModels.length, 1);
    assert.equal(loaded.data.enabledModels[0]?.id, 'local-llama-enabled');
    assert.equal(loaded.data.getEnabledModelById('local-llama-disabled'), null);
  });

  it('fails closed on invalid registry and rejects duplicate model IDs', () => {
    const invalid = loadModelRegistry('{ broken json');
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.code, 'INVALID_REGISTRY');
    }

    const dupRegistry = createSampleRegistry([
      {
        id: 'dup-model',
        displayName: 'Model A',
        providerType: 'local-open-source',
        adapter: 'mock',
        endpoint: 'http://localhost:11434/v1',
        apiKeyEnvVar: null,
        license: 'MIT',
        costTier: 'free',
        capabilities: ['text-generation'],
        contextWindow: 4096,
        maxAutonomyAllowed: 'L2',
        enabled: true,
        addedAt: FIXED_NOW,
      },
      {
        id: 'dup-model',
        displayName: 'Model B',
        providerType: 'local-open-source',
        adapter: 'mock',
        endpoint: 'http://localhost:11434/v1',
        apiKeyEnvVar: null,
        license: 'MIT',
        costTier: 'free',
        capabilities: ['text-generation'],
        contextWindow: 4096,
        maxAutonomyAllowed: 'L2',
        enabled: true,
        addedAt: FIXED_NOW,
      },
    ]);

    const dupResult = loadModelRegistry(dupRegistry);
    assert.equal(dupResult.ok, false);
    if (!dupResult.ok) {
      assert.ok(dupResult.errors.some((e) => e.keyword === 'duplicate_id'));
    }
  });
});

describe('Stage 2 — Mock Adapter & Policy-Gated Gateway (Zero Network Calls)', () => {
  it('returns deterministic mock response without touching global fetch', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('Network call should never happen in mock tests');
    }) as typeof fetch;

    try {
      const model = createSampleRegistry([
        {
          id: 'mock-local-1',
          displayName: 'Mock Local',
          providerType: 'local-open-source',
          adapter: 'mock',
          endpoint: 'http://localhost:11434/v1',
          apiKeyEnvVar: null,
          license: 'MIT',
          costTier: 'free',
          capabilities: ['text-generation'],
          contextWindow: 8192,
          maxAutonomyAllowed: 'L2',
          enabled: true,
          addedAt: FIXED_NOW,
        },
      ]).models[0]!;

      const adapter = new MockModelAdapter();
      const response = await invokeModelThroughGateway({
        request: {
          request_id: 'req_mock_1',
          correlation_id: 'corr_mock_1',
          model_id: 'mock-local-1',
          messages: [{ role: 'user', content: 'Summarize governance state.' }],
        },
        model,
        adapter,
        policy_context: createLocalPolicyContext(),
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(fetchCalls, 0);
      assert.equal(response.ok, true);
      if (response.ok) {
        assert.equal(
          response.output_text,
          '[mock:mock-local-1] Summarize governance state.',
        );
        assert.ok(response.usage.total_tokens > 0);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('denies missing policy context, disabled models, capability mismatches, and unapproved remote calls', async () => {
    const adapter = new MockModelAdapter();
    const localModel = createSampleRegistry([
      {
        id: 'mock-local-1',
        displayName: 'Mock Local',
        providerType: 'local-open-source',
        adapter: 'mock',
        endpoint: 'http://localhost:11434/v1',
        apiKeyEnvVar: null,
        license: 'MIT',
        costTier: 'free',
        capabilities: ['text-generation'],
        contextWindow: 8192,
        maxAutonomyAllowed: 'L2',
        enabled: true,
        addedAt: FIXED_NOW,
      },
    ]).models[0]!;

    const missingPolicy = await invokeModelThroughGateway({
      request: {
        request_id: 'req_1',
        correlation_id: 'corr_1',
        model_id: 'mock-local-1',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      model: localModel,
      adapter,
      policy_context: null,
    });
    assert.equal(missingPolicy.ok, false);
    if (!missingPolicy.ok) {
      assert.equal(missingPolicy.error.code, 'POLICY_CONTEXT_MISSING');
    }

    const disabledModelRes = await invokeModelThroughGateway({
      request: {
        request_id: 'req_2',
        correlation_id: 'corr_2',
        model_id: 'mock-local-1',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      model: { ...localModel, enabled: false },
      adapter,
      policy_context: createLocalPolicyContext(),
    });
    assert.equal(disabledModelRes.ok, false);
    if (!disabledModelRes.ok) {
      assert.equal(disabledModelRes.error.code, 'POLICY_DENIED');
    }

    const capMismatch = await invokeModelThroughGateway({
      request: {
        request_id: 'req_3',
        correlation_id: 'corr_3',
        model_id: 'mock-local-1',
        messages: [{ role: 'user', content: 'Hello' }],
        required_capabilities: ['tool-calling'],
      },
      model: localModel,
      adapter,
      policy_context: createLocalPolicyContext(),
    });
    assert.equal(capMismatch.ok, false);
    if (!capMismatch.ok) {
      assert.equal(capMismatch.error.code, 'CAPABILITY_NOT_SUPPORTED');
    }

    const remoteModel = {
      ...localModel,
      id: 'remote-free-1',
      providerType: 'free-cloud-tier' as const,
      endpoint: 'https://api.example.org/v1',
      maxAutonomyAllowed: 'L3' as const,
    };

    const unapprovedRemote = await invokeModelThroughGateway({
      request: {
        request_id: 'req_4',
        correlation_id: 'corr_4',
        model_id: 'remote-free-1',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      model: remoteModel,
      adapter,
      policy_context: createLocalPolicyContext({
        actor: {
          id: 'agent_planner',
          type: 'agent',
          trusted_autonomy_level: 'L3',
        },
        environment: 'staging',
        declared_scopes: ['model:invoke:remote'],
        approval: null,
      }),
    });
    assert.equal(unapprovedRemote.ok, false);
    if (!unapprovedRemote.ok) {
      assert.equal(unapprovedRemote.error.code, 'APPROVAL_REQUIRED');
    }

    const approvedRemote = await invokeModelThroughGateway({
      request: {
        request_id: 'req_5',
        correlation_id: 'corr_5',
        model_id: 'remote-free-1',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      model: remoteModel,
      adapter,
      policy_context: createLocalPolicyContext({
        actor: {
          id: 'agent_planner',
          type: 'agent',
          trusted_autonomy_level: 'L3',
        },
        environment: 'staging',
        declared_scopes: ['model:invoke:remote'],
        approval: createRemoteApproval('remote-free-1'),
      }),
    });
    assert.equal(approvedRemote.ok, true);
  });
});

describe('Stage 2 — Local OpenAI-Compatible Adapter', () => {
  const localModel = createSampleRegistry([
    {
      id: 'ollama-llama3',
      displayName: 'Ollama Llama 3',
      providerType: 'local-open-source',
      adapter: 'openai-compatible',
      endpoint: 'http://localhost:11434/v1',
      apiKeyEnvVar: 'LOCAL_LLM_KEY',
      license: 'open-weights',
      costTier: 'free',
      capabilities: ['text-generation'],
      contextWindow: 8192,
      maxAutonomyAllowed: 'L2',
      enabled: true,
      addedAt: FIXED_NOW,
    },
  ]).models[0]!;

  it('rejects non-allowlisted endpoints and handles timeouts, cancellations, and secret-redacted provider errors', async () => {
    let fetchCount = 0;
    const unlistedAdapter = new OpenAICompatibleLocalAdapter({
      allowedEndpoints: ['http://localhost:11434/v1'],
      fetchImpl: (async () => {
        fetchCount += 1;
        throw new Error('Should not be called');
      }) as FetchLike,
    });

    const unlistedRes = await unlistedAdapter.generateText(
      {
        request_id: 'req_u1',
        correlation_id: 'corr_u1',
        model_id: 'ollama-llama3',
        messages: [{ role: 'user', content: 'hi' }],
      },
      {
        model: { ...localModel, endpoint: 'http://169.254.169.254/v1' },
      },
    );
    assert.equal(fetchCount, 0);
    assert.equal(unlistedRes.ok, false);
    if (!unlistedRes.ok) {
      assert.equal(unlistedRes.error.code, 'ENDPOINT_NOT_ALLOWLISTED');
    }

    const secretResolver: SecretResolver = {
      resolveSecret: (name) =>
        name === 'LOCAL_LLM_KEY' ? 'sk-secret-local-token-9999' : null,
    };

    // Timeout simulation
    const timeoutAdapter = new OpenAICompatibleLocalAdapter({
      allowedEndpoints: ['http://localhost:11434/v1'],
      defaultTimeoutMs: 15,
      fetchImpl: ((_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })) as FetchLike,
    });

    const timeoutRes = await timeoutAdapter.generateText(
      {
        request_id: 'req_t1',
        correlation_id: 'corr_t1',
        model_id: 'ollama-llama3',
        messages: [{ role: 'user', content: 'hi' }],
        timeout_ms: 15,
      },
      { model: localModel, secretResolver },
    );
    assert.equal(timeoutRes.ok, false);
    if (!timeoutRes.ok) {
      assert.equal(timeoutRes.error.code, 'TIMEOUT');
      assert.equal(timeoutRes.error.retryable, true);
    }

    // Cancellation simulation
    const cancelController = new AbortController();
    cancelController.abort();
    const cancelRes = await timeoutAdapter.generateText(
      {
        request_id: 'req_c1',
        correlation_id: 'corr_c1',
        model_id: 'ollama-llama3',
        messages: [{ role: 'user', content: 'hi' }],
        signal: cancelController.signal,
      },
      { model: localModel, secretResolver },
    );
    assert.equal(cancelRes.ok, false);
    if (!cancelRes.ok) {
      assert.equal(cancelRes.error.code, 'CANCELLED');
      assert.equal(cancelRes.error.retryable, false);
    }

    // Provider HTTP error normalization & secret redaction
    const errorAdapter = new OpenAICompatibleLocalAdapter({
      allowedEndpoints: ['http://localhost:11434/v1'],
      fetchImpl: (async () =>
        new Response('Auth failed for Bearer sk-secret-local-token-9999', {
          status: 401,
        })) as FetchLike,
    });

    const httpErrRes = await errorAdapter.generateText(
      {
        request_id: 'req_e1',
        correlation_id: 'corr_e1',
        model_id: 'ollama-llama3',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { model: localModel, secretResolver },
    );
    assert.equal(httpErrRes.ok, false);
    if (!httpErrRes.ok) {
      assert.equal(httpErrRes.error.code, 'PROVIDER_HTTP_ERROR');
      assert.equal(httpErrRes.error.status_code, 401);
      assert.equal(httpErrRes.error.retryable, false);
      assert.equal(
        httpErrRes.error.message.includes('sk-secret-local-token-9999'),
        false,
      );
      assert.equal(httpErrRes.error.message.includes('[REDACTED_SECRET]'), true);
    }
  });
});
