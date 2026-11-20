import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { Approval } from '../../contracts/types/index.ts';
import { AuditLogger, type AuditStorage } from '../audit/index.ts';
import {
  evaluatePolicy,
  evaluatePolicyWithAudit,
  type PolicyEvaluationInput,
} from '../policy/index.ts';

const SYSTEM_CONFIG = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), 'core/configuration/system.json'),
    'utf8',
  ),
);

const FIXED_NOW = '2026-11-20T12:00:00Z';

function createValidL3Approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'apr_staging_01',
    task_id: 'task_staging_01',
    action: 'deploy:staging',
    requested_by: 'agent_deployer',
    requested_at: '2026-11-20T11:50:00Z',
    status: 'approved',
    reviewed_by: 'owner:primary',
    reviewed_at: '2026-11-20T11:55:00Z',
    reason: 'Approved staging deployment for verification.',
    environment: 'staging',
    scope: {
      resources: ['env:staging-app'],
      permissions: ['deploy:staging'],
      single_use: true,
      expires_at: '2026-11-20T13:00:00Z',
    },
    ...overrides,
  };
}

function createBaseInput(
  overrides: Partial<PolicyEvaluationInput> = {},
): PolicyEvaluationInput {
  return {
    actor: {
      id: 'agent_worker',
      type: 'agent',
      trusted_autonomy_level: 'L2',
    },
    action: 'sandbox:write',
    resource: { id: 'sandbox:tmp/draft.txt', type: 'filesystem' },
    environment: 'sandbox',
    declared_scopes: ['fs:write:sandbox'],
    approval: null,
    system_config: SYSTEM_CONFIG,
    now: FIXED_NOW,
    ...overrides,
  };
}

describe('Stage 1 — Deterministic Policy Evaluator', () => {
  it('enforces default-deny on invalid config, missing identity, missing scope, unknown action, and wildcards', () => {
    const badConfigRes = evaluatePolicy(
      createBaseInput({ system_config: { invalid: true } }),
    );
    assert.equal(badConfigRes.allowed, false);
    assert.equal(badConfigRes.decision, 'deny');
    assert.equal(badConfigRes.reason_code, 'INVALID_SYSTEM_CONFIG');

    const missingActorRes = evaluatePolicy(
      createBaseInput({
        actor: { id: '', type: 'agent', trusted_autonomy_level: 'L2' },
      }),
    );
    assert.equal(missingActorRes.allowed, false);
    assert.equal(missingActorRes.decision, 'deny');

    const missingScopeRes = evaluatePolicy(
      createBaseInput({ declared_scopes: [] }),
    );
    assert.equal(missingScopeRes.allowed, false);
    assert.equal(missingScopeRes.reason_code, 'MISSING_DECLARED_SCOPES');

    const wrongScopeRes = evaluatePolicy(
      createBaseInput({ declared_scopes: ['fs:read:workspace'] }),
    );
    assert.equal(wrongScopeRes.allowed, false);
    assert.equal(wrongScopeRes.reason_code, 'MISSING_REQUIRED_SCOPE');

    const unknownActionRes = evaluatePolicy(
      createBaseInput({ action: 'shell:arbitrary_exec' }),
    );
    assert.equal(unknownActionRes.allowed, false);
    assert.equal(unknownActionRes.reason_code, 'UNKNOWN_ACTION');

    const wildcardRes = evaluatePolicy(
      createBaseInput({ declared_scopes: ['fs:*'] }),
    );
    assert.equal(wildcardRes.allowed, false);
    assert.equal(wildcardRes.reason_code, 'WILDCARD_SCOPE_FORBIDDEN');
  });

  it('allows L2 bounded sandbox permission only in sandbox and blocks production', () => {
    const allowed = evaluatePolicy(createBaseInput());
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.decision, 'allow');
    assert.equal(allowed.required_approval_level, 'L2');

    const prodDenied = evaluatePolicy(
      createBaseInput({ environment: 'production' }),
    );
    assert.equal(prodDenied.allowed, false);
    assert.equal(prodDenied.decision, 'deny');
  });

  it('blocks L3 without approval and allows L3 only with valid matching owner approval', () => {
    const l3NoApproval = evaluatePolicy(
      createBaseInput({
        actor: {
          id: 'agent_deployer',
          type: 'agent',
          trusted_autonomy_level: 'L3',
        },
        action: 'deploy:staging',
        resource: { id: 'env:staging-app', type: 'deployment' },
        environment: 'staging',
        declared_scopes: ['deploy:staging'],
        approval: null,
      }),
    );
    assert.equal(l3NoApproval.allowed, false);
    assert.equal(l3NoApproval.decision, 'require_approval');
    assert.equal(l3NoApproval.required_approval_level, 'L3');

    const l3Approved = evaluatePolicy(
      createBaseInput({
        actor: {
          id: 'agent_deployer',
          type: 'agent',
          trusted_autonomy_level: 'L3',
        },
        action: 'deploy:staging',
        resource: { id: 'env:staging-app', type: 'deployment' },
        environment: 'staging',
        declared_scopes: ['deploy:staging'],
        approval: createValidL3Approval(),
      }),
    );
    assert.equal(l3Approved.allowed, true);
    assert.equal(l3Approved.decision, 'allow');
  });

  it('denies L4 agent execution, agent self-approval, and requester self-approval', () => {
    for (const l4Action of [
      { action: 'deploy:production', env: 'production' as const, scope: 'deploy:production' },
      { action: 'billing:transact', env: 'production' as const, scope: 'billing:transact' },
      { action: 'publish:public', env: 'production' as const, scope: 'publish:public' },
      { action: 'permission:grant', env: 'local' as const, scope: 'governance:grant' },
      { action: 'governance:modify', env: 'local' as const, scope: 'governance:write' },
      { action: 'credential:access', env: 'local' as const, scope: 'secrets:access' },
      { action: 'data:delete', env: 'local' as const, scope: 'data:delete' },
    ]) {
      const res = evaluatePolicy(
        createBaseInput({
          actor: {
            id: 'agent_admin_attempt',
            type: 'agent',
            trusted_autonomy_level: 'L3',
          },
          action: l4Action.action,
          environment: l4Action.env,
          declared_scopes: [l4Action.scope],
          approval: createValidL3Approval({
            action: l4Action.action,
            environment: l4Action.env,
            scope: {
              resources: ['sandbox:tmp/draft.txt'],
              permissions: [l4Action.scope],
              single_use: true,
              expires_at: '2026-11-20T13:00:00Z',
            },
          }),
        }),
      );
      assert.equal(res.allowed, false);
      assert.equal(res.decision, 'deny');
    }

    const agentSelfApproval = evaluatePolicy(
      createBaseInput({
        actor: {
          id: 'agent_deployer',
          type: 'agent',
          trusted_autonomy_level: 'L3',
        },
        action: 'deploy:staging',
        resource: { id: 'env:staging-app', type: 'deployment' },
        environment: 'staging',
        declared_scopes: ['deploy:staging'],
        approval: createValidL3Approval({
          requested_by: 'agent_deployer',
          reviewed_by: 'agent_deployer',
        }),
      }),
    );
    assert.equal(agentSelfApproval.allowed, false);
    assert.equal(agentSelfApproval.decision, 'deny');

    const requesterSelfApproval = evaluatePolicy(
      createBaseInput({
        actor: {
          id: 'owner:primary',
          type: 'owner',
          trusted_autonomy_level: 'L4',
          trusted_authenticated: true,
        },
        action: 'deploy:staging',
        resource: { id: 'env:staging-app', type: 'deployment' },
        environment: 'staging',
        declared_scopes: ['deploy:staging'],
        approval: createValidL3Approval({
          requested_by: 'owner:primary',
          reviewed_by: 'owner:primary',
        }),
      }),
    );
    assert.equal(requesterSelfApproval.allowed, false);
    assert.equal(requesterSelfApproval.decision, 'deny');
  });

  it('denies wrong resource, wrong environment, expired, rejected, and reused single-use approvals', () => {
    const baseL3 = {
      actor: {
        id: 'agent_deployer',
        type: 'agent' as const,
        trusted_autonomy_level: 'L3' as const,
      },
      action: 'deploy:staging',
      resource: { id: 'env:staging-app', type: 'deployment' },
      environment: 'staging' as const,
      declared_scopes: ['deploy:staging'],
    };

    const wrongResource = evaluatePolicy(
      createBaseInput({
        ...baseL3,
        approval: createValidL3Approval({
          scope: {
            resources: ['env:other-app'],
            permissions: ['deploy:staging'],
            single_use: true,
            expires_at: '2026-11-20T13:00:00Z',
          },
        }),
      }),
    );
    assert.equal(wrongResource.allowed, false);
    assert.equal(wrongResource.reason_code, 'APPROVAL_RESOURCE_MISMATCH');

    const wrongEnv = evaluatePolicy(
      createBaseInput({
        ...baseL3,
        approval: createValidL3Approval({ environment: 'sandbox' }),
      }),
    );
    assert.equal(wrongEnv.allowed, false);
    assert.equal(wrongEnv.reason_code, 'APPROVAL_ENVIRONMENT_MISMATCH');

    const expired = evaluatePolicy(
      createBaseInput({
        ...baseL3,
        now: '2026-11-20T14:00:00Z',
        approval: createValidL3Approval(),
      }),
    );
    assert.equal(expired.allowed, false);
    assert.equal(expired.reason_code, 'APPROVAL_EXPIRED');

    const rejected = evaluatePolicy(
      createBaseInput({
        ...baseL3,
        approval: createValidL3Approval({ status: 'rejected' }),
      }),
    );
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.reason_code, 'APPROVAL_REJECTED');

    const reused = evaluatePolicy(
      createBaseInput({
        ...baseL3,
        approval: createValidL3Approval(),
        approval_consumed: true,
      }),
    );
    assert.equal(reused.allowed, false);
    assert.equal(reused.reason_code, 'SINGLE_USE_APPROVAL_CONSUMED');
  });

  it('fails closed when audit storage fails (audit failure never yields allow)', () => {
    const failingStorage: AuditStorage = {
      appendLine: () => ({ ok: false, error: 'Simulated disk full failure' }),
    };
    const auditLogger = new AuditLogger({
      storage: failingStorage,
      clock: () => new Date(FIXED_NOW),
      idGenerator: () => 'evt_fixed_01',
    });

    const result = evaluatePolicyWithAudit({
      ...createBaseInput(),
      audit_logger: auditLogger,
      correlation_id: 'corr_audit_fail_01',
    });

    assert.equal(result.allowed, false);
    assert.equal(result.decision, 'deny');
    assert.equal(result.reason_code, 'AUDIT_STORAGE_FAILURE');
  });
});
