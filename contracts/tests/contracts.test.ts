import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  Agent,
  Approval,
  AuditEvent,
  Task,
  Tool,
} from '../types/index.ts';
import {
  createContractValidator,
  parseAndValidateContract,
  validateAgent,
  validateApproval,
  validateAuditEvent,
  validateContract,
  validateTask,
  validateTool,
} from '../validation/index.ts';

function createValidTask(): Task {
  return {
    id: 'task_01J001',
    type: 'governance.policy_check',
    title: 'Validate system configuration policy',
    description: 'Inspect system.json for compliance with TEJAURA constitution.',
    status: 'queued',
    autonomy_level: 'L1',
    created_at: '2026-11-20T12:00:00Z',
    updated_at: '2026-11-20T12:00:00Z',
    requested_by: 'owner:primary',
    assigned_agent_id: 'agent_policy_auditor',
    input: {
      target_path: 'core/configuration/system.json',
      dry_run: true,
    },
    result: null,
    error: null,
    approval_ids: [],
    schema_version: '1.0.0',
  };
}

function createValidAgent(): Agent {
  return {
    id: 'agent_policy_auditor',
    name: 'Policy Auditor',
    department: 'governance',
    role: 'Read-only policy and configuration reviewer',
    description:
      'Inspects proposals and configurations without mutating files or granting permissions.',
    status: 'active',
    enabled: true,
    permitted_autonomy_level: 'L1',
    allowed_tool_ids: ['tool_read_workspace'],
    preferred_model_ids: ['local-llama-3'],
    created_at: '2026-11-20T12:00:00Z',
    schema_version: '1.0.0',
  };
}

function createValidTool(): Tool {
  return {
    id: 'tool_read_workspace',
    name: 'Read Workspace File',
    description: 'Reads a non-secret file inside an allowed workspace path.',
    category: 'filesystem',
    input_schema_ref: 'contracts/schemas/tool-io/read-input.schema.json',
    output_schema_ref: 'contracts/schemas/tool-io/read-output.schema.json',
    permission_scope: 'fs:read:workspace',
    risk_level: 'low',
    enabled: true,
    schema_version: '1.0.0',
  };
}

function createValidApproval(): Approval {
  return {
    id: 'apr_01J001',
    task_id: 'task_01J001',
    action: 'deploy:production',
    requested_by: 'agent_release_manager',
    requested_at: '2026-11-20T12:05:00Z',
    status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    reason: 'Production deployment requires explicit human owner approval.',
    scope: {
      resources: ['env:production'],
      permissions: ['deploy:production'],
      single_use: true,
      expires_at: '2026-11-20T13:05:00Z',
    },
    schema_version: '1.0.0',
  };
}

function createValidAuditEvent(): AuditEvent {
  return {
    id: 'evt_01J001',
    timestamp: '2026-11-20T12:05:01Z',
    actor_type: 'policy_engine',
    actor_id: 'core_policy_evaluator',
    event_type: 'approval.requested',
    resource_type: 'approval',
    resource_id: 'apr_01J001',
    action: 'request_owner_approval',
    outcome: 'pending',
    approval_id: 'apr_01J001',
    metadata: {
      task_id: 'task_01J001',
      autonomy_level: 'L4',
    },
    schema_version: '1.0.0',
  };
}

describe('TEJAURA Core Contracts — Valid Objects', () => {
  it('validates a compliant Task object including result and error states', () => {
    const queued = validateTask(createValidTask());
    assert.equal(queued.valid, true);
    assert.equal(queued.errors.length, 0);

    const failedTask: Task = {
      ...createValidTask(),
      status: 'failed',
      error: {
        code: 'POLICY_DENIED',
        message: 'Action requires explicit owner approval.',
        retryable: false,
      },
      approval_ids: ['apr_01J001'],
    };
    const failedResult = validateTask(failedTask);
    assert.equal(failedResult.valid, true);
  });

  it('validates a compliant Agent object', () => {
    const res = validateAgent(createValidAgent());
    assert.equal(res.valid, true);
    assert.equal(res.data?.id, 'agent_policy_auditor');
  });

  it('validates a compliant Tool object', () => {
    const res = validateTool(createValidTool());
    assert.equal(res.valid, true);
    assert.equal(res.data?.permission_scope, 'fs:read:workspace');
  });

  it('validates compliant pending and approved Approval objects', () => {
    const pendingRes = validateApproval(createValidApproval());
    assert.equal(pendingRes.valid, true);

    const approved: Approval = {
      ...createValidApproval(),
      status: 'approved',
      reviewed_by: 'owner:primary',
      reviewed_at: '2026-11-20T12:06:00Z',
    };
    const approvedRes = validateApproval(approved);
    assert.equal(approvedRes.valid, true);
  });

  it('validates a compliant AuditEvent object', () => {
    const res = validateAuditEvent(createValidAuditEvent());
    assert.equal(res.valid, true);
    assert.equal(res.data?.actor_type, 'policy_engine');
  });
});

describe('TEJAURA Core Contracts — Missing Required Properties', () => {
  it('rejects a Task missing required fields', () => {
    const incomplete = { ...createValidTask() } as Record<string, unknown>;
    delete incomplete.title;
    delete incomplete.approval_ids;

    const res = validateTask(incomplete);
    assert.equal(res.valid, false);
    assert.equal(res.data, null);
    assert.ok(res.errors.some((e) => e.keyword === 'required'));
  });

  it('rejects an Agent missing permitted_autonomy_level', () => {
    const incomplete = { ...createValidAgent() } as Record<string, unknown>;
    delete incomplete.permitted_autonomy_level;

    const res = validateAgent(incomplete);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.message.includes('permitted_autonomy_level')));
  });

  it('rejects a Tool missing permission_scope', () => {
    const incomplete = { ...createValidTool() } as Record<string, unknown>;
    delete incomplete.permission_scope;

    const res = validateTool(incomplete);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.message.includes('permission_scope')));
  });

  it('rejects an Approval missing scope or nested scope fields', () => {
    const incomplete = {
      ...createValidApproval(),
      scope: { resources: ['env:production'] },
    };

    const res = validateApproval(incomplete);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.keyword === 'required'));
  });

  it('rejects an AuditEvent missing outcome', () => {
    const incomplete = { ...createValidAuditEvent() } as Record<string, unknown>;
    delete incomplete.outcome;

    const res = validateAuditEvent(incomplete);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.message.includes('outcome')));
  });
});

describe('TEJAURA Core Contracts — Enum & Governance Enforcement', () => {
  it('rejects invalid Task status and autonomy_level', () => {
    const badStatus = { ...createValidTask(), status: 'auto_approved' };
    assert.equal(validateTask(badStatus).valid, false);

    const badLevel = { ...createValidTask(), autonomy_level: 'L5' };
    assert.equal(validateTask(badLevel).valid, false);
  });

  it('rejects L4 on Agent permitted_autonomy_level (owner-exclusive invariant)', () => {
    const escalatedAgent = {
      ...createValidAgent(),
      permitted_autonomy_level: 'L4',
    };
    const res = validateAgent(escalatedAgent);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.path === '/permitted_autonomy_level'.replace('/', '$/') || e.path === '$/permitted_autonomy_level'));
  });

  it('rejects invalid Tool category and risk_level', () => {
    assert.equal(
      validateTool({ ...createValidTool(), category: 'arbitrary' }).valid,
      false,
    );
    assert.equal(
      validateTool({ ...createValidTool(), risk_level: 'extreme' }).valid,
      false,
    );
  });

  it('rejects invalid Approval status', () => {
    assert.equal(
      validateApproval({ ...createValidApproval(), status: 'self_approved' }).valid,
      false,
    );
  });

  it('rejects invalid AuditEvent actor_type, resource_type, and outcome', () => {
    assert.equal(
      validateAuditEvent({ ...createValidAuditEvent(), actor_type: 'anonymous' }).valid,
      false,
    );
    assert.equal(
      validateAuditEvent({ ...createValidAuditEvent(), resource_type: 'wallet' }).valid,
      false,
    );
    assert.equal(
      validateAuditEvent({ ...createValidAuditEvent(), outcome: 'ignored' }).valid,
      false,
    );
  });
});

describe('TEJAURA Core Contracts — Timestamp Validation', () => {
  it('rejects non-RFC3339 or malformed timestamps across contracts', () => {
    assert.equal(
      validateTask({ ...createValidTask(), created_at: 'not-a-timestamp' }).valid,
      false,
    );
    assert.equal(
      validateTask({ ...createValidTask(), updated_at: '2026-11-20' }).valid,
      false,
    );
    assert.equal(
      validateAgent({ ...createValidAgent(), created_at: '2026-99-99T00:00:00Z' }).valid,
      false,
    );
    assert.equal(
      validateApproval({ ...createValidApproval(), requested_at: '12:00:00' }).valid,
      false,
    );
    assert.equal(
      validateApproval({ ...createValidApproval(), reviewed_at: 'invalid-date' }).valid,
      false,
    );
    assert.equal(
      validateAuditEvent({ ...createValidAuditEvent(), timestamp: '2026/11/20' }).valid,
      false,
    );
  });
});

describe('TEJAURA Core Contracts — Unexpected Properties & Secret Protection', () => {
  it('rejects unexpected additional properties on all contract types', () => {
    assert.equal(
      validateTask({ ...createValidTask(), bypass_approval: true }).valid,
      false,
    );
    assert.equal(
      validateAgent({ ...createValidAgent(), admin_override: true }).valid,
      false,
    );
    assert.equal(
      validateTool({ ...createValidTool(), raw_shell: true }).valid,
      false,
    );
    assert.equal(
      validateApproval({ ...createValidApproval(), auto_grant: true }).valid,
      false,
    );
    assert.equal(
      validateAuditEvent({ ...createValidAuditEvent(), extra_field: 'nope' }).valid,
      false,
    );
  });

  it('rejects credential or API key property names inside payloads and metadata', () => {
    const taskWithSecret = {
      ...createValidTask(),
      input: { api_key: 'should-never-be-stored' },
    };
    assert.equal(validateTask(taskWithSecret).valid, false);

    const auditWithSecret = {
      ...createValidAuditEvent(),
      metadata: { password: 'secret-value' },
    };
    assert.equal(validateAuditEvent(auditWithSecret).valid, false);
  });
});

describe('TEJAURA Core Contracts — Malformed Input & Fail-Closed Behavior', () => {
  it('fails closed on null, undefined, arrays, primitives, and unknown contract kinds', () => {
    for (const badInput of [null, undefined, [], 'string', 42, true]) {
      const res = validateTask(badInput);
      assert.equal(res.valid, false);
      assert.equal(res.data, null);
      assert.ok(res.errors.length > 0);
    }

    const unknownKind = validateContract('unknown' as 'task', createValidTask());
    assert.equal(unknownKind.valid, false);
    assert.equal(unknownKind.errors[0]?.keyword, 'unknown_contract_kind');
  });

  it('never bypasses validation on malformed JSON strings', () => {
    const malformed = parseAndValidateContract('task', '{ "id": "task_1", ');
    assert.equal(malformed.valid, false);
    assert.equal(malformed.data, null);
    assert.equal(malformed.errors[0]?.keyword, 'json_parse');

    const nonString = parseAndValidateContract(
      'agent',
      123 as unknown as string,
    );
    assert.equal(nonString.valid, false);
    assert.equal(nonString.errors[0]?.keyword, 'json_parse');

    const validJson = parseAndValidateContract(
      'tool',
      JSON.stringify(createValidTool()),
    );
    assert.equal(validJson.valid, true);
  });

  it('fails closed safely if schema compilation fails', () => {
    const brokenValidator = createContractValidator({
      task: { $schema: 'invalid-schema-uri', type: 'not-a-valid-json-type' },
      agent: {},
      tool: {},
      approval: {},
      audit_event: {},
    });

    const res = brokenValidator.validateTask(createValidTask());
    assert.equal(res.valid, false);
    assert.equal(res.data, null);
    assert.equal(res.errors[0]?.keyword, 'schema_compilation');
  });
});
