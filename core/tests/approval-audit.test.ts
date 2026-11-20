import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ApprovalService } from '../approvals/index.ts';
import {
  AuditLogger,
  InMemoryAuditStorage,
  JsonlAuditStorage,
} from '../audit/index.ts';

describe('Stage 1 — Approval Gatekeeper State Machine', () => {
  function createHarness(startIso = '2026-11-20T12:00:00Z') {
    let currentTime = new Date(startIso);
    let seq = 0;
    const storage = new InMemoryAuditStorage();
    const auditLogger = new AuditLogger({
      storage,
      clock: () => currentTime,
      idGenerator: () => `evt_${++seq}`,
    });
    const service = new ApprovalService({
      designatedOwnerId: 'owner:primary',
      auditLogger,
      clock: () => currentTime,
      idGenerator: () => `apr_${++seq}`,
    });

    return {
      service,
      storage,
      setTime: (iso: string) => {
        currentTime = new Date(iso);
      },
    };
  }

  it('enforces pending -> approved and prevents single-use reuse and invalid state transitions', () => {
    const { service } = createHarness();

    const created = service.requestApproval({
      task_id: 'task_100',
      action: 'deploy:staging',
      requested_by: 'agent_deployer',
      environment: 'staging',
      reason: 'Deploy release candidate to staging.',
      scope: {
        resources: ['env:staging'],
        permissions: ['deploy:staging'],
        single_use: true,
        expires_at: '2026-11-20T13:00:00Z',
      },
      correlation_id: 'corr_100',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.record.status, 'pending');

    const approved = service.decideApproval({
      approval_id: created.record.id,
      decision: 'approved',
      reviewer: {
        actor_id: 'owner:primary',
        actor_type: 'owner',
        authenticated: true,
        auth_source: 'external-session',
      },
      reason: 'Verified diff looks safe for staging.',
      correlation_id: 'corr_100',
    });
    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.equal(approved.record.status, 'approved');

    // Terminal decision cannot transition again.
    const invalidReDecision = service.decideApproval({
      approval_id: created.record.id,
      decision: 'rejected',
      reviewer: {
        actor_id: 'owner:primary',
        actor_type: 'owner',
        authenticated: true,
        auth_source: 'external-session',
      },
      reason: 'Attempted overwrite after approval.',
      correlation_id: 'corr_100',
    });
    assert.equal(invalidReDecision.ok, false);
    if (!invalidReDecision.ok) {
      assert.equal(invalidReDecision.code, 'INVALID_STATE_TRANSITION');
    }

    // Wrong environment fails closed before consumption.
    const wrongEnv = service.verifyAndConsumeApproval({
      approval_id: created.record.id,
      task_id: 'task_100',
      action: 'deploy:staging',
      resource_id: 'env:staging',
      required_scope: 'deploy:staging',
      environment: 'production',
      actor_id: 'agent_deployer',
      correlation_id: 'corr_100',
    });
    assert.equal(wrongEnv.ok, false);

    // First valid consumption succeeds.
    const firstUse = service.verifyAndConsumeApproval({
      approval_id: created.record.id,
      task_id: 'task_100',
      action: 'deploy:staging',
      resource_id: 'env:staging',
      required_scope: 'deploy:staging',
      environment: 'staging',
      actor_id: 'agent_deployer',
      correlation_id: 'corr_100',
    });
    assert.equal(firstUse.ok, true);

    // Second attempt on single-use approval is denied.
    const secondUse = service.verifyAndConsumeApproval({
      approval_id: created.record.id,
      task_id: 'task_100',
      action: 'deploy:staging',
      resource_id: 'env:staging',
      required_scope: 'deploy:staging',
      environment: 'staging',
      actor_id: 'agent_deployer',
      correlation_id: 'corr_100',
    });
    assert.equal(secondUse.ok, false);
    if (!secondUse.ok) {
      assert.equal(secondUse.code, 'SINGLE_USE_ALREADY_CONSUMED');
    }
  });

  it('rejects agent approval, unauthenticated approval, and requester self-approval', () => {
    const { service } = createHarness();

    const created = service.requestApproval({
      task_id: 'task_200',
      action: 'external:api_call',
      requested_by: 'owner:primary',
      environment: 'local',
      reason: 'Need external fetch.',
      scope: {
        resources: ['api:weather'],
        permissions: ['net:egress:approved'],
        single_use: true,
        expires_at: '2026-11-20T13:00:00Z',
      },
      correlation_id: 'corr_200',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const agentAttempt = service.decideApproval({
      approval_id: created.record.id,
      decision: 'approved',
      reviewer: {
        actor_id: 'agent_helper',
        actor_type: 'agent',
        authenticated: true,
        auth_source: 'internal',
      },
      reason: 'Agent trying to approve.',
      correlation_id: 'corr_200',
    });
    assert.equal(agentAttempt.ok, false);
    if (!agentAttempt.ok) {
      assert.equal(agentAttempt.code, 'AGENT_APPROVAL_FORBIDDEN');
    }

    const unauthAttempt = service.decideApproval({
      approval_id: created.record.id,
      decision: 'approved',
      reviewer: {
        actor_id: 'owner:primary',
        actor_type: 'owner',
        authenticated: false,
        auth_source: 'none',
      },
      reason: 'Unauthenticated attempt.',
      correlation_id: 'corr_200',
    });
    assert.equal(unauthAttempt.ok, false);
    if (!unauthAttempt.ok) {
      assert.equal(unauthAttempt.code, 'UNAUTHENTICATED_REVIEWER');
    }

    // Even designated owner cannot self-approve a request they created.
    const selfAttempt = service.decideApproval({
      approval_id: created.record.id,
      decision: 'approved',
      reviewer: {
        actor_id: 'owner:primary',
        actor_type: 'owner',
        authenticated: true,
        auth_source: 'external-session',
      },
      reason: 'Requester self-approval attempt.',
      correlation_id: 'corr_200',
    });
    assert.equal(selfAttempt.ok, false);
    if (!selfAttempt.ok) {
      assert.equal(selfAttempt.code, 'SELF_APPROVAL_FORBIDDEN');
    }
  });

  it('transitions pending -> rejected and pending -> expired and blocks subsequent approval', () => {
    const { service, setTime } = createHarness();

    const req1 = service.requestApproval({
      task_id: 'task_301',
      action: 'deploy:staging',
      requested_by: 'agent_deployer',
      environment: 'staging',
      reason: 'Stage deploy 1.',
      scope: {
        resources: ['env:staging'],
        permissions: ['deploy:staging'],
        single_use: true,
        expires_at: '2026-11-20T12:30:00Z',
      },
      correlation_id: 'corr_301',
    });
    assert.equal(req1.ok, true);
    if (!req1.ok) return;

    const rejected = service.decideApproval({
      approval_id: req1.record.id,
      decision: 'rejected',
      reviewer: {
        actor_id: 'owner:primary',
        actor_type: 'owner',
        authenticated: true,
        auth_source: 'external-session',
      },
      reason: 'Wait for test suite fixes.',
      correlation_id: 'corr_301',
    });
    assert.equal(rejected.ok, true);
    if (rejected.ok) {
      assert.equal(rejected.record.status, 'rejected');
    }

    const req2 = service.requestApproval({
      task_id: 'task_302',
      action: 'deploy:staging',
      requested_by: 'agent_deployer',
      environment: 'staging',
      reason: 'Stage deploy 2.',
      scope: {
        resources: ['env:staging'],
        permissions: ['deploy:staging'],
        single_use: true,
        expires_at: '2026-11-20T12:15:00Z',
      },
      correlation_id: 'corr_302',
    });
    assert.equal(req2.ok, true);
    if (!req2.ok) return;

    setTime('2026-11-20T12:20:00Z');
    const lateApprove = service.decideApproval({
      approval_id: req2.record.id,
      decision: 'approved',
      reviewer: {
        actor_id: 'owner:primary',
        actor_type: 'owner',
        authenticated: true,
        auth_source: 'external-session',
      },
      reason: 'Too late.',
      correlation_id: 'corr_302',
    });
    assert.equal(lateApprove.ok, false);
    if (!lateApprove.ok) {
      assert.equal(lateApprove.code, 'APPROVAL_EXPIRED');
    }
    assert.equal(service.getApproval(req2.record.id)?.status, 'expired');
  });
});

describe('Stage 1 — Append-Only JSONL Audit Logger', () => {
  it('appends JSONL lines without overwriting previous events and strips secret-like fields', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-audit-'));

    try {
      const storage = new JsonlAuditStorage({
        auditDir: tempDir,
        fileName: 'security-audit.jsonl',
      });

      const logger = new AuditLogger({
        storage,
        clock: () => new Date('2026-11-20T12:00:00Z'),
        idGenerator: (() => {
          let n = 0;
          return () => `evt_${++n}`;
        })(),
      });

      const first = logger.logPolicyDecision({
        actor_type: 'agent',
        actor_id: 'agent_worker',
        resource_type: 'system',
        resource_id: 'sandbox:file.txt',
        action: 'sandbox:write',
        decision: 'allow',
        reason_code: 'POLICY_ALLOW',
        correlation_id: 'corr_audit_1',
        metadata: {
          api_key: 'sk-super-secret-value-1234567890',
          nested: {
            password: 'my-secret-password',
            raw_token: 'Bearer eyJhbGciOiJIUzI1NiJ9',
          },
          safe_note: 'non-secret-context',
        },
      });
      assert.equal(first.ok, true);

      const second = logger.logPolicyDecision({
        actor_type: 'agent',
        actor_id: 'agent_worker',
        resource_type: 'system',
        resource_id: 'env:production',
        action: 'deploy:production',
        decision: 'deny',
        reason_code: 'OWNER_EXCLUSIVE_ACTION_DENIED',
        correlation_id: 'corr_audit_2',
      });
      assert.equal(second.ok, true);

      const content = fs.readFileSync(storage.getFilePath(), 'utf8');
      const lines = content.trim().split('\n');
      assert.equal(lines.length, 2);

      // Secret-like field names and secret values must never appear in audit logs.
      assert.equal(content.includes('api_key'), false);
      assert.equal(content.includes('sk-super-secret-value'), false);
      assert.equal(content.includes('password'), false);
      assert.equal(content.includes('my-secret-password'), false);
      assert.equal(content.includes('eyJhbGciOiJIUzI1NiJ9'), false);
      assert.equal(content.includes('non-secret-context'), true);

      const parsedFirst = JSON.parse(lines[0]!);
      const parsedSecond = JSON.parse(lines[1]!);
      assert.equal(parsedFirst.id, 'evt_1');
      assert.equal(parsedFirst.metadata.secrets_redacted, true);
      assert.equal(parsedSecond.id, 'evt_2');
      assert.equal(parsedSecond.outcome, 'denied');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses writing audit logs into public web directories or path traversal targets', () => {
    const publicStorage = new JsonlAuditStorage({
      auditDir: path.join(process.cwd(), 'public/audit'),
    });
    assert.equal(publicStorage.appendLine('{"id":"evt_1"}').ok, false);

    const srcStorage = new JsonlAuditStorage({
      auditDir: path.join(process.cwd(), 'src/audit'),
    });
    assert.equal(srcStorage.appendLine('{"id":"evt_1"}').ok, false);

    const traversalStorage = new JsonlAuditStorage({
      auditDir: os.tmpdir(),
      fileName: '../escape.jsonl',
    });
    assert.equal(traversalStorage.appendLine('{"id":"evt_1"}').ok, false);
  });
});
