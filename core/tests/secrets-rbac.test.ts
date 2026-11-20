import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApprovalService } from '../approvals/index.ts';
import { AuditLogger, InMemoryAuditStorage } from '../audit/index.ts';
import { evaluatePolicy } from '../policy/index.ts';
import systemConfig from '../configuration/system.json' with { type: 'json' };
import {
  RbacRoleRegistry,
  authorizeRbac,
  principalToPolicyActor,
  principalToTrustedReviewerContext,
} from '../rbac/index.ts';
import type { RbacPrincipal } from '../rbac/index.ts';
import {
  AIRLLM_WORKER_TOKEN_ENV_VAR,
  EnvSecretProvider,
  FileEncryptedVaultBackend,
  SecretsManager,
  redactKnownSecrets,
} from '../secrets/index.ts';

const TEST_MASTER_KEY = 'synthetic-vault-master-key-do-not-use-prod-32b';
const TEST_WORKER_TOKEN = 'synthetic-airllm-worker-token-999';

const OWNER_PRINCIPAL: RbacPrincipal = {
  actor_id: 'owner_primary',
  actor_type: 'owner',
  role: 'owner',
  authenticated: true,
  auth_source: 'tejaura-owner-session',
};

const READONLY_PRINCIPAL: RbacPrincipal = {
  actor_id: 'operator_1',
  actor_type: 'system',
  role: 'operator_readonly',
  authenticated: true,
  auth_source: 'tejaura-operator-session',
};

const AGENT_PRINCIPAL: RbacPrincipal = {
  actor_id: 'agent_planner',
  actor_type: 'agent',
  role: 'agent_restricted',
  authenticated: true,
  auth_source: 'tejaura-agent-runtime',
};

const WORKER_PRINCIPAL: RbacPrincipal = {
  actor_id: 'airllm_runtime_adapter',
  actor_type: 'adapter',
  role: 'worker_service',
  authenticated: true,
  auth_source: 'tejaura-internal-runtime',
};

test('RBAC enforces default-deny, rejects unauthenticated principals, and blocks agent privilege escalation', () => {
  const storage = new InMemoryAuditStorage();
  const auditLogger = new AuditLogger({ storage });

  // Unauthenticated owner is denied.
  const unauth = authorizeRbac({
    principal: { ...OWNER_PRINCIPAL, authenticated: false },
    permission: 'governance:read',
    correlation_id: 'corr_unauth',
    auditLogger,
  });
  assert.equal(unauth.allowed, false);

  // Unknown permission denied (default-deny).
  const unknownPerm = authorizeRbac({
    principal: OWNER_PRINCIPAL,
    permission: 'nonexistent:wildcard:*',
    correlation_id: 'corr_unknown_perm',
    auditLogger,
  });
  assert.equal(unknownPerm.allowed, false);

  // Agent claiming owner role is strictly blocked.
  const agentClaimingOwner = authorizeRbac({
    principal: {
      actor_id: 'agent_rogue',
      actor_type: 'agent',
      role: 'owner',
      authenticated: true,
      auth_source: 'spoofed',
    },
    permission: 'approval:decide',
    correlation_id: 'corr_agent_owner',
    auditLogger,
  });
  assert.equal(agentClaimingOwner.allowed, false);
  if (!agentClaimingOwner.allowed) {
    assert.equal(agentClaimingOwner.reason_code, 'AGENT_OWNER_ROLE_FORBIDDEN');
  }

  // Agent blocked from approvals, RBAC changes, and secret reads.
  for (const perm of [
    'approval:decide',
    'rbac:manage',
    'auth:admin',
    'secrets:read',
    'worker:airllm:token',
  ]) {
    const res = authorizeRbac({
      principal: AGENT_PRINCIPAL,
      permission: perm,
      correlation_id: `corr_agent_${perm}`,
      auditLogger,
    });
    assert.equal(res.allowed, false);
  }

  // Read-only operator cannot write secrets or decide approvals.
  assert.equal(
    authorizeRbac({
      principal: READONLY_PRINCIPAL,
      permission: 'governance:read',
    }).allowed,
    true,
  );
  assert.equal(
    authorizeRbac({
      principal: READONLY_PRINCIPAL,
      permission: 'secrets:read',
    }).allowed,
    false,
  );
  assert.equal(
    authorizeRbac({
      principal: READONLY_PRINCIPAL,
      permission: 'approval:decide',
    }).allowed,
    false,
  );

  // RBAC role registry rejects agent trying to escalate role, allows owner with audit event.
  const registry = new RbacRoleRegistry({}, auditLogger);
  const agentEscalate = registry.assignRole({
    actor: AGENT_PRINCIPAL,
    target_actor_id: 'agent_planner',
    target_actor_type: 'agent',
    new_role: 'owner',
    correlation_id: 'corr_rbac_esc',
  });
  assert.equal(agentEscalate.ok, false);

  const ownerAssign = registry.assignRole({
    actor: OWNER_PRINCIPAL,
    target_actor_id: 'operator_1',
    target_actor_type: 'system',
    new_role: 'operator_readonly',
    correlation_id: 'corr_rbac_assign',
  });
  assert.equal(ownerAssign.ok, true);

  const events = storage.getEvents();
  assert.ok(events.some((e) => e.event_type === 'rbac.role.assigned'));
  assert.ok(events.some((e) => e.event_type === 'rbac.access.denied'));
});

test('Owner-only approval preservation prevents non-owners from deciding L3/L4 approvals', () => {
  const approvals = new ApprovalService({ designatedOwnerId: 'owner_primary' });
  const req = approvals.requestApproval({
    task_id: 'task-202',
    action: 'deploy:staging',
    requested_by: 'agent_planner',
    environment: 'staging',
    reason: 'Deploy staging build',
    scope: {
      resources: ['staging-cluster'],
      permissions: ['deploy:staging'],
      single_use: true,
    },
    correlation_id: 'corr_req',
  });
  assert.equal(req.ok, true);
  if (!req.ok) return;

  // Agent principal cannot decide approval.
  const agentDecision = approvals.decideApproval({
    approval_id: req.record.id,
    decision: 'approved',
    reviewer: principalToTrustedReviewerContext(AGENT_PRINCIPAL),
    reason: 'Agent attempt',
    correlation_id: 'corr_agent_dec',
  });
  assert.equal(agentDecision.ok, false);

  // Agent policy actor cannot execute L4 actions.
  const l4Policy = evaluatePolicy({
    actor: principalToPolicyActor(AGENT_PRINCIPAL),
    action: 'auth:admin',
    resource: { id: 'owner:primary', type: 'system' },
    environment: 'local',
    declared_scopes: ['auth:admin'],
    system_config: systemConfig,
  });
  assert.equal(l4Policy.allowed, false);
});

test('SecretsManager isolates TEJAURA_AIRLLM_WORKER_TOKEN, blocks agents/frontend, encrypts vault, and audits access without leaking secrets', () => {
  const storage = new InMemoryAuditStorage();
  const auditLogger = new AuditLogger({ storage });
  const envProvider = new EnvSecretProvider({
    env: {
      [AIRLLM_WORKER_TOKEN_ENV_VAR]: TEST_WORKER_TOKEN,
    },
  });

  const secrets = new SecretsManager({
    masterKeyMaterial: TEST_MASTER_KEY,
    envProvider,
    auditLogger,
  });

  // Agents are strictly denied secrets and TEJAURA_AIRLLM_WORKER_TOKEN.
  const agentRead = secrets.getAirLlmWorkerToken({
    principal: AGENT_PRINCIPAL,
    correlation_id: 'corr_agent_worker_token',
  });
  assert.equal(agentRead.ok, false);

  // Worker runtime adapter can read TEJAURA_AIRLLM_WORKER_TOKEN, but not arbitrary external credentials.
  const workerRead = secrets.getAirLlmWorkerToken({
    principal: WORKER_PRINCIPAL,
    correlation_id: 'corr_worker_token',
  });
  assert.equal(workerRead.ok, true);
  if (workerRead.ok) {
    assert.equal(workerRead.value, TEST_WORKER_TOKEN);
  }

  // Owner can store & rotate encrypted vault secret.
  const setRes = secrets.setSecret({
    principal: OWNER_PRINCIPAL,
    key: 'REMOTE_NODE_CERT_PIN',
    value: 'synthetic-cert-pin-value-1234',
    scope: 'external_credential',
    correlation_id: 'corr_set_secret',
  });
  assert.equal(setRes.ok, true);

  // Worker service cannot read owner's external credential secret.
  const workerExternal = secrets.getSecret({
    principal: WORKER_PRINCIPAL,
    key: 'REMOTE_NODE_CERT_PIN',
    correlation_id: 'corr_worker_ext',
  });
  assert.equal(workerExternal.ok, false);

  // Owner can retrieve decrypted secret.
  const ownerGet = secrets.getSecret({
    principal: OWNER_PRINCIPAL,
    key: 'REMOTE_NODE_CERT_PIN',
    correlation_id: 'corr_owner_get',
  });
  assert.equal(ownerGet.ok, true);
  if (ownerGet.ok) {
    assert.equal(ownerGet.value, 'synthetic-cert-pin-value-1234');
  }

  // Public-safe inventory lists metadata ONLY (never values).
  const inventory = secrets.listMetadata({
    principal: READONLY_PRINCIPAL,
    correlation_id: 'corr_inventory',
  });
  assert.equal(inventory.ok, true);
  const invStr = JSON.stringify(inventory);
  assert.equal(invStr.includes(TEST_WORKER_TOKEN), false);
  assert.equal(invStr.includes('synthetic-cert-pin-value-1234'), false);

  // Audit logs record secret events without leaking any secret values.
  const rawAudit = storage.getLines().join('\n');
  assert.equal(rawAudit.includes(TEST_WORKER_TOKEN), false);
  assert.equal(rawAudit.includes('synthetic-cert-pin-value-1234'), false);
  const eventTypes = storage.getEvents().map((e) => e.event_type);
  assert.ok(eventTypes.includes('secret.accessed'));
  assert.ok(eventTypes.includes('secret.stored'));
  assert.ok(eventTypes.includes('secret.access_denied'));

  // Redaction helper removes known secret strings.
  const redacted = redactKnownSecrets(
    `Error connecting with ${TEST_WORKER_TOKEN}`,
    [TEST_WORKER_TOKEN],
  );
  assert.equal(redacted.includes(TEST_WORKER_TOKEN), false);
});

test('FileEncryptedVaultBackend stores AES-256-GCM ciphertext on disk and refuses public web dirs', () => {
  assert.throws(
    () => new FileEncryptedVaultBackend(path.join(os.tmpdir(), 'public')),
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-vault-'));
  try {
    const backend = new FileEncryptedVaultBackend(tmpDir);
    const secrets = new SecretsManager({
      masterKeyMaterial: TEST_MASTER_KEY,
      vaultBackend: backend,
    });

    const write = secrets.setSecret({
      principal: OWNER_PRINCIPAL,
      key: 'LOCAL_TLS_PASSPHRASE',
      value: 'synthetic-tls-passphrase-99',
      scope: 'encryption_key',
      correlation_id: 'corr_vault_disk',
    });
    assert.equal(write.ok, true);

    const rawFile = fs.readFileSync(
      path.join(tmpDir, 'secrets.vault.json'),
      'utf8',
    );
    assert.equal(rawFile.includes('synthetic-tls-passphrase-99'), false);
    assert.match(rawFile, /"alg": "aes-256-gcm"/);

    // No secrets exist inside frontend src/ files.
    const srcFiles = fs.readdirSync(path.resolve('src'));
    for (const file of srcFiles) {
      const content = fs.readFileSync(path.resolve('src', file), 'utf8');
      assert.equal(content.includes('TEJAURA_AIRLLM_WORKER_TOKEN'), false);
      assert.equal(content.includes('TEJAURA_SECRETS_MASTER_KEY'), false);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
