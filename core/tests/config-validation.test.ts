import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  parseAndValidateSystemConfig,
  validateSystemConfig,
} from '../configuration/validate-system-config.ts';
import {
  parseAndValidateModelRegistry,
  validateModelRegistry,
} from '../../intelligence/model-registry/validate-model-registry.ts';

const REPO_ROOT = process.cwd();
const systemJsonRaw = fs.readFileSync(
  path.join(REPO_ROOT, 'core/configuration/system.json'),
  'utf8',
);
const modelsJsonRaw = fs.readFileSync(
  path.join(REPO_ROOT, 'intelligence/model-registry/models.json'),
  'utf8',
);

describe('Stage 1 — System Configuration Validation', () => {
  it('validates the repository core/configuration/system.json', () => {
    const res = parseAndValidateSystemConfig(systemJsonRaw);
    assert.equal(res.valid, true);
    assert.equal(res.data?.governance.humanOwnerControl, true);
    assert.equal(res.data?.governance.allowAgentSelfApproval, false);
    assert.equal(res.data?.governance.allowAgentSelfPermission, false);
  });

  it('rejects configurations enabling agent self-approval, self-permission, or secrets', () => {
    const base = JSON.parse(systemJsonRaw);

    const selfApproval = structuredClone(base);
    selfApproval.governance.allowAgentSelfApproval = true;
    assert.equal(validateSystemConfig(selfApproval).valid, false);

    const selfPermission = structuredClone(base);
    selfPermission.governance.allowAgentSelfPermission = true;
    assert.equal(validateSystemConfig(selfPermission).valid, false);

    const secretsInSource = structuredClone(base);
    secretsInSource.security.allowSecretsInSource = true;
    assert.equal(validateSystemConfig(secretsInSource).valid, false);

    const secretsInConfig = structuredClone(base);
    secretsInConfig.security.allowSecretsInConfig = true;
    assert.equal(validateSystemConfig(secretsInConfig).valid, false);
  });

  it('rejects weakened L4 gates, unknown properties, invalid autonomy ceilings, and malformed JSON', () => {
    const base = JSON.parse(systemJsonRaw);

    const weakGate = structuredClone(base);
    weakGate.approvalGates.productionDeployments.allowAutoApprove = true;
    assert.equal(validateSystemConfig(weakGate).valid, false);

    const badCeiling = structuredClone(base);
    badCeiling.governance.defaultAutonomyLevel = 'L2';
    badCeiling.governance.maxAutonomousLevel = 'L1';
    const ceilingRes = validateSystemConfig(badCeiling);
    assert.equal(ceilingRes.valid, false);
    assert.equal(ceilingRes.errors[0]?.keyword, 'autonomy_ceiling_exceeded');

    const extraProp = structuredClone(base);
    extraProp.unexpectedFlag = true;
    assert.equal(validateSystemConfig(extraProp).valid, false);

    const malformed = parseAndValidateSystemConfig('{ "system": ');
    assert.equal(malformed.valid, false);
    assert.equal(malformed.errors[0]?.keyword, 'json_parse');
  });
});

describe('Stage 1 — Model Registry Validation', () => {
  it('validates the repository intelligence/model-registry/models.json baseline', () => {
    const res = parseAndValidateModelRegistry(modelsJsonRaw);
    assert.equal(res.valid, true);
    assert.deepEqual(res.data?.models, []);
    assert.equal(res.data?.defaultModelId, null);
  });

  it('validates a compliant registered local open-source model', () => {
    const base = JSON.parse(modelsJsonRaw);
    base.defaultModelId = 'local-llama-3';
    base.models = [
      {
        id: 'local-llama-3',
        displayName: 'Local Llama 3',
        providerType: 'local-open-source',
        adapter: 'openai-compatible',
        endpoint: 'http://localhost:11434/v1',
        apiKeyEnvVar: null,
        license: 'open-weights',
        costTier: 'free',
        capabilities: ['text-generation', 'reasoning'],
        contextWindow: 8192,
        maxAutonomyAllowed: 'L2',
        enabled: true,
        addedAt: '2026-11-20T00:00:00Z',
      },
    ];

    const res = validateModelRegistry(base);
    assert.equal(res.valid, true);
  });

  it('rejects secrets in registry, L4 model autonomy, disabled defaultModelId, and credentialed URLs', () => {
    const base = JSON.parse(modelsJsonRaw);

    const allowSecrets = structuredClone(base);
    allowSecrets.policy.allowSecretsInRegistry = true;
    assert.equal(validateModelRegistry(allowSecrets).valid, false);

    const hardcodedKey = structuredClone(base);
    hardcodedKey.models = [
      {
        id: 'bad-model',
        displayName: 'Bad Model',
        providerType: 'paid-api',
        adapter: 'openai',
        endpoint: 'https://api.example.com/v1',
        apiKeyEnvVar: 'sk-live-secret-123456',
        license: 'proprietary',
        costTier: 'metered-high',
        capabilities: ['text-generation'],
        contextWindow: 4096,
        maxAutonomyAllowed: 'L2',
        enabled: true,
        addedAt: '2026-11-20T00:00:00Z',
      },
    ];
    assert.equal(validateModelRegistry(hardcodedKey).valid, false);

    const l4Model = structuredClone(base);
    l4Model.models = [
      {
        id: 'l4-model',
        displayName: 'L4 Model',
        providerType: 'local-open-source',
        adapter: 'ollama',
        endpoint: 'http://localhost:11434',
        apiKeyEnvVar: null,
        license: 'MIT',
        costTier: 'free',
        capabilities: ['reasoning'],
        contextWindow: 8192,
        maxAutonomyAllowed: 'L4',
        enabled: true,
        addedAt: '2026-11-20T00:00:00Z',
      },
    ];
    assert.equal(validateModelRegistry(l4Model).valid, false);

    const disabledDefault = structuredClone(base);
    disabledDefault.defaultModelId = 'disabled-model';
    disabledDefault.models = [
      {
        id: 'disabled-model',
        displayName: 'Disabled Model',
        providerType: 'local-open-source',
        adapter: 'ollama',
        endpoint: 'http://localhost:11434',
        apiKeyEnvVar: null,
        license: 'MIT',
        costTier: 'free',
        capabilities: ['reasoning'],
        contextWindow: 8192,
        maxAutonomyAllowed: 'L1',
        enabled: false,
        addedAt: '2026-11-20T00:00:00Z',
      },
    ];
    assert.equal(validateModelRegistry(disabledDefault).valid, false);

    const urlCreds = structuredClone(base);
    urlCreds.models = [
      {
        id: 'cred-url-model',
        displayName: 'Cred URL Model',
        providerType: 'self-hosted',
        adapter: 'ollama',
        endpoint: 'https://user:password@localhost:11434',
        apiKeyEnvVar: null,
        license: 'MIT',
        costTier: 'free',
        capabilities: ['reasoning'],
        contextWindow: 8192,
        maxAutonomyAllowed: 'L1',
        enabled: true,
        addedAt: '2026-11-20T00:00:00Z',
      },
    ];
    assert.equal(validateModelRegistry(urlCreds).valid, false);
  });
});
