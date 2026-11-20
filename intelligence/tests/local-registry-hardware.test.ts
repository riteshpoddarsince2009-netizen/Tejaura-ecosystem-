import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import systemConfig from '../../core/configuration/system.json' with { type: 'json' };
import { AuditLogger, InMemoryAuditStorage } from '../../core/audit/index.ts';
import {
  checkHardwareFit,
  HardwareManager,
  type ComputeNode,
} from '../hardware/index.ts';
import localModelsBaseline from '../model-registry/local-models.json' with { type: 'json' };
import {
  LocalModelRegistry,
  parseAndValidateLocalModelRegistry,
  validateLocalModelRegistry,
  type LocalModelEntry,
} from '../model-registry/local-model-registry.ts';

function makeValidModel(overrides: Partial<LocalModelEntry> = {}): LocalModelEntry {
  return {
    model_id: 'qwen2.5-coder-7b-q4',
    model_name: 'qwen2.5-coder:7b',
    model_family: 'qwen2.5',
    model_version: '7b-instruct-q4_K_M',
    local_model_path: 'models/qwen2.5-coder-7b-q4_K_M.gguf',
    controlled_runtime_endpoint: 'http://127.0.0.1:11434',
    runtime_type: 'ollama',
    capabilities: ['chat', 'text_generation', 'code'],
    hardware_requirements: {
      min_ram_mb: 8192,
      min_vram_mb: 6144,
      min_storage_mb: 5120,
      requires_gpu: true,
    },
    quantization: 'Q4_K_M',
    context_length: 32768,
    enabled: true,
    availability: 'available',
    license: {
      name: 'Apache-2.0',
      spdx_id: 'Apache-2.0',
      open_weight: true,
      commercial_use_allowed: true,
    },
    ...overrides,
  };
}

function makeNode(overrides: Partial<ComputeNode> = {}): ComputeNode {
  return {
    node_id: 'node-local-gpu',
    name: 'Local Workstation',
    location: 'local',
    total_ram_mb: 32768,
    available_ram_mb: 16384,
    total_vram_mb: 12288,
    available_vram_mb: 10240,
    total_storage_mb: 512000,
    available_storage_mb: 100000,
    has_gpu: true,
    gpu_name: 'RTX 3060 12GB',
    supported_runtimes: ['ollama', 'llama_cpp'],
    installed_model_ids: ['qwen2.5-coder-7b-q4'],
    online: true,
    last_seen_at: '2026-11-20T12:00:00Z',
    ...overrides,
  };
}

describe('Stage 2 — Local Model Registry & Hardware Abstraction', () => {
  it('validates the empty baseline local-models.json document', () => {
    const res = validateLocalModelRegistry(localModelsBaseline);
    assert.equal(res.valid, true);
    if (!res.valid) return;
    assert.equal(res.data.models.length, 0);
    assert.equal(res.data.local_first_only, true);
    assert.equal(res.data.allow_paid_third_party_apis, false);
    assert.equal(res.data.allow_secrets, false);
  });

  it('rejects secret-like keys, paid API URLs, credentials in URLs, and path traversal', () => {
    const withSecret = {
      ...localModelsBaseline,
      models: [{ ...makeValidModel(), api_key: 'sk-should-never-exist' }],
    };
    assert.equal(validateLocalModelRegistry(withSecret).valid, false);

    const withPaidHost = {
      ...localModelsBaseline,
      models: [
        makeValidModel({
          controlled_runtime_endpoint: 'https://api.openai.com/v1',
        }),
      ],
    };
    assert.equal(validateLocalModelRegistry(withPaidHost).valid, false);

    const withUrlCreds = {
      ...localModelsBaseline,
      models: [
        makeValidModel({
          controlled_runtime_endpoint: 'http://user:pass@127.0.0.1:11434',
        }),
      ],
    };
    assert.equal(validateLocalModelRegistry(withUrlCreds).valid, false);

    const withTraversal = {
      ...localModelsBaseline,
      models: [
        makeValidModel({
          local_model_path: '../../../etc/passwd',
          controlled_runtime_endpoint: null,
        }),
      ],
    };
    assert.equal(validateLocalModelRegistry(withTraversal).valid, false);

    const malformed = parseAndValidateLocalModelRegistry('{not-json');
    assert.equal(malformed.valid, false);
  });

  it('enforces L4 owner-only authorization for registry mutations (denies agents)', () => {
    const auditLogger = new AuditLogger({ storage: new InMemoryAuditStorage() });
    const registry = new LocalModelRegistry(localModelsBaseline as never);
    const model = makeValidModel();

    const agentAttempt = registry.registerModel(model, {
      actor: {
        id: 'agent_planner',
        type: 'agent',
        trusted_autonomy_level: 'L2',
      },
      declared_scopes: ['model:registry:write'],
      system_config: systemConfig,
      audit_logger: auditLogger,
      correlation_id: 'corr_reg_1',
    });
    assert.equal(agentAttempt.ok, false);
    assert.equal(registry.listModels().length, 0);

    const ownerAttempt = registry.registerModel(model, {
      actor: {
        id: 'owner:primary',
        type: 'owner',
        trusted_autonomy_level: 'L4',
        trusted_authenticated: true,
      },
      declared_scopes: ['model:registry:write'],
      system_config: systemConfig,
      audit_logger: auditLogger,
      correlation_id: 'corr_reg_2',
    });
    assert.equal(ownerAttempt.ok, true);
    assert.equal(registry.listModels().length, 1);
  });

  it('verifies RAM, VRAM, storage, GPU, runtime, and online status before claiming fit', () => {
    const model = makeValidModel();
    const okNode = makeNode();
    assert.equal(checkHardwareFit(model, okNode).fits, true);

    assert.equal(
      checkHardwareFit(model, makeNode({ online: false })).code,
      'NODE_OFFLINE',
    );
    assert.equal(
      checkHardwareFit(model, makeNode({ has_gpu: false })).code,
      'GPU_REQUIRED',
    );
    assert.equal(
      checkHardwareFit(model, makeNode({ available_vram_mb: 2048 })).code,
      'INSUFFICIENT_VRAM',
    );
    assert.equal(
      checkHardwareFit(model, makeNode({ available_ram_mb: 4096 })).code,
      'INSUFFICIENT_RAM',
    );
    assert.equal(
      checkHardwareFit(model, makeNode({ available_storage_mb: 1024 })).code,
      'INSUFFICIENT_STORAGE',
    );
    assert.equal(
      checkHardwareFit(model, makeNode({ supported_runtimes: ['vllm'] })).code,
      'UNSUPPORTED_RUNTIME',
    );
    assert.equal(
      checkHardwareFit(
        model,
        makeNode({ available_vram_mb: 999999, total_vram_mb: 12288 }),
      ).code,
      'INVALID_NODE_TELEMETRY',
    );

    const hw = new HardwareManager([
      makeNode({ node_id: 'cpu-only', has_gpu: false, available_vram_mb: 0 }),
      okNode,
    ]);
    const best = hw.findBestCompatibleNode(model);
    assert.equal(best.fit.fits, true);
    assert.equal(best.node?.node_id, 'node-local-gpu');
  });
});
