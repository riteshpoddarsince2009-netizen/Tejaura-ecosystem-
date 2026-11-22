import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { Agent, Approval, Tool } from '../../contracts/types/index.ts';
import {
  ApprovalService,
  type TrustedReviewerContext,
} from '../../core/approvals/index.ts';
import { AuditLogger, InMemoryAuditStorage } from '../../core/audit/index.ts';
import systemConfig from '../../core/configuration/system.json' with { type: 'json' };
import type { PolicyActor } from '../../core/policy/index.ts';
import { SqliteOrchestrationStore } from '../../control-plane/db/index.ts';
import { createControlPlaneApp } from '../../control-plane/server/index.ts';
import {
  AgentExecutionEngine,
  MockSandboxAdapter,
  type SandboxExecutionContext,
} from '../index.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent_eng_01',
    name: 'Engineering Sandbox Worker',
    department: 'engineering',
    role: 'backend_sandbox_executor',
    description: 'Executes bounded engineering tasks in sandbox.',
    status: 'active',
    enabled: true,
    permitted_autonomy_level: 'L2',
    allowed_tool_ids: ['tool_sandbox_exec', 'tool_workspace_read'],
    preferred_model_ids: ['qwen2.5-7b-instruct-airllm'],
    created_at: '2026-11-20T12:00:00Z',
    schema_version: '1.0.0',
    ...overrides,
  };
}

function createTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: 'tool_sandbox_exec',
    name: 'Bounded Sandbox Step Runner',
    description: 'Runs deterministic bounded sandbox operations.',
    category: 'utility',
    input_schema_ref: 'contracts/schemas/task.schema.json',
    output_schema_ref: 'contracts/schemas/task.schema.json',
    permission_scope: 'exec:run:sandbox',
    risk_level: 'low',
    enabled: true,
    schema_version: '1.0.0',
    ...overrides,
  };
}

const OWNER_ACTOR: PolicyActor = {
  id: 'owner_primary',
  type: 'owner',
  trusted_autonomy_level: 'L4',
  trusted_authenticated: true,
};

const OWNER_REVIEWER: TrustedReviewerContext = {
  actor_id: 'owner_primary',
  actor_type: 'owner',
  authenticated: true,
  auth_source: 'argon2id-session',
};

const AGENT_INITIATOR: PolicyActor = {
  id: 'agent_eng_01',
  type: 'agent',
  trusted_autonomy_level: 'L2',
  trusted_authenticated: true,
};

function createTestHarness(opts?: {
  dbPath?: string;
  workspaceRoot?: string;
  allowedRelativePaths?: string[];
  adapter?: MockSandboxAdapter;
  knownSecretValues?: string[];
}) {
  const dir = makeTempDir('tejaura-stage4-');
  const workspaceRoot = opts?.workspaceRoot ?? dir;
  fs.mkdirSync(path.join(workspaceRoot, 'sandbox'), { recursive: true });

  const dbPath = opts?.dbPath ?? path.join(dir, 'stage4.db');
  const store = new SqliteOrchestrationStore({ dbPath });
  const auditStorage = new InMemoryAuditStorage();
  const auditLogger = new AuditLogger({ storage: auditStorage });
  const approvals = new ApprovalService({
    designatedOwnerId: 'owner_primary',
    store,
    auditLogger,
  });
  const adapter =
    opts?.adapter ??
    new MockSandboxAdapter({
      knownSecretValues: opts?.knownSecretValues ?? [],
    });

  const engine = new AgentExecutionEngine({
    store,
    approvals,
    auditLogger,
    systemConfig,
    policyConfig: {
      workspaceRoot,
      allowedRelativePaths: opts?.allowedRelativePaths ?? ['sandbox'],
      defaultNetworkMode: 'none',
      defaultBrowserMode: 'disabled',
      knownSecretValues: opts?.knownSecretValues ?? [],
    },
    adapters: [adapter],
    defaultSandboxProvider: 'mock_sandbox_v1',
  });

  return { dir, workspaceRoot, dbPath, store, auditStorage, auditLogger, approvals, adapter, engine };
}

describe('Stage 4 — Sandboxed Agent Execution Foundation', () => {
  it('1. executes an approved bounded mock agent job cleanly and stores job state + structured logs', async () => {
    const h = createTestHarness();
    try {
      const agent = createAgent();
      const tool = createTool();

      const submitRes = h.engine.submitExecution(
        {
          task_id: 'task_eng_mock_01',
          title: 'Run bounded engineering analysis',
          description: 'Simulate deterministic sandbox check.',
          agent,
          tools: [tool],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:drafts.plan.json',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox', 'fs:read:workspace'],
          requested_paths: ['sandbox/plan.json'],
          input: { target: 'module-a', step: 'dry-run' },
        },
        {
          initiator: AGENT_INITIATOR,
          correlation_id: 'corr_s4_01',
        },
      );

      assert.equal(submitRes.ok, true);
      if (!submitRes.ok) return;
      assert.equal(submitRes.job.status, 'queued');
      assert.equal(submitRes.job.isolation_level, 'mock_in_process');
      assert.equal(submitRes.job.sandbox_provider, 'mock_sandbox_v1');

      const runOutcome = await h.engine.runJob(submitRes.job.job_id);
      assert.equal(runOutcome.executed, true);
      assert.equal(runOutcome.job?.status, 'completed');
      assert.ok(runOutcome.job?.started_at);
      assert.ok(runOutcome.job?.finished_at);
      assert.equal(runOutcome.job?.result?.os_isolated, false);
      assert.equal(runOutcome.job?.result?.paid_api_fallback_used, false);
      assert.equal(runOutcome.job?.result?.simulated, true);

      const logs = h.engine.listExecutionLogs({ jobId: submitRes.job.job_id });
      assert.equal(logs.length, 3); // queued -> running -> completed
      assert.equal(logs[0]?.outcome, 'completed');
      assert.equal(logs[0]?.permission_decision, 'allow');

      const adapters = h.engine.listAdapters();
      assert.equal(adapters[0]?.supportsOsIsolation, false);
      assert.match(adapters[0]!.isolationDisclaimer, /NOT provide OS-level/i);
    } finally {
      h.store.close();
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('2. rejects unauthorized execution requests (L4 agent, disabled agent/tool, path escape, shell exec, unrestricted net/browser, privilege escalation)', () => {
    const h = createTestHarness();
    try {
      // a) Agent attempting L4 autonomy fails contract validation
      const l4Agent = { ...createAgent(), permitted_autonomy_level: 'L4' } as unknown as Agent;
      const l4Res = h.engine.submitExecution(
        {
          task_id: 'task_unauth_l4',
          title: 'L4 escalation attempt',
          description: 'Attempt L4 agent execution.',
          agent: l4Agent,
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:test',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox'],
          input: {},
        },
        { initiator: AGENT_INITIATOR, correlation_id: 'corr_unauth_l4' },
      );
      assert.equal(l4Res.ok, false);
      if (!l4Res.ok) assert.equal(l4Res.code, 'INVALID_AGENT_CONTRACT');

      // b) Unallowlisted / disallowed tool
      const badToolRes = h.engine.submitExecution(
        {
          task_id: 'task_unauth_tool',
          title: 'Disallowed tool',
          description: 'Invoke tool not in agent allowlist.',
          agent: createAgent(),
          tools: [createTool({ id: 'tool_unlisted' })],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:test',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox'],
          input: {},
        },
        { initiator: AGENT_INITIATOR, correlation_id: 'corr_unauth_tool' },
      );
      assert.equal(badToolRes.ok, false);
      if (!badToolRes.ok) assert.equal(badToolRes.code, 'TOOL_NOT_ALLOWED_FOR_AGENT');

      // c) Path traversal and protected governance path
      const traversalRes = h.engine.submitExecution(
        {
          task_id: 'task_unauth_path',
          title: 'Path escape',
          description: 'Attempt traversal out of sandbox.',
          agent: createAgent(),
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:test',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox', 'fs:read:workspace'],
          requested_paths: ['../etc/passwd'],
          input: {},
        },
        { initiator: AGENT_INITIATOR, correlation_id: 'corr_unauth_path' },
      );
      assert.equal(traversalRes.ok, false);
      if (!traversalRes.ok) assert.equal(traversalRes.code, 'PATH_TRAVERSAL_OR_ABSOLUTE_FORBIDDEN');

      const govPathRes = h.engine.submitExecution(
        {
          task_id: 'task_unauth_gov',
          title: 'Protected file read',
          description: 'Attempt reading .env file.',
          agent: createAgent(),
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:test',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox', 'fs:read:workspace'],
          requested_paths: ['sandbox/.env.production'],
          input: {},
        },
        { initiator: AGENT_INITIATOR, correlation_id: 'corr_unauth_gov' },
      );
      assert.equal(govPathRes.ok, false);
      if (!govPathRes.ok) assert.equal(govPathRes.code, 'PROTECTED_PATH_FORBIDDEN');

      // d) Arbitrary shell execution blocked
      const shellRes = h.engine.submitExecution(
        {
          task_id: 'task_unauth_shell',
          title: 'Shell exec',
          description: 'Attempt shell execution.',
          agent: createAgent(),
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:test',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox'],
          requested_shell_command: 'rm -rf /',
          input: {},
        },
        { initiator: AGENT_INITIATOR, correlation_id: 'corr_unauth_shell' },
      );
      assert.equal(shellRes.ok, false);
      if (!shellRes.ok) assert.equal(shellRes.code, 'SHELL_EXECUTION_FORBIDDEN');

      // e) Unrestricted network & browser & paid third-party AI host blocked
      const netRes = h.engine.submitExecution(
        {
          task_id: 'task_unauth_net',
          title: 'Unrestricted net',
          description: 'Request unrestricted egress.',
          agent: createAgent(),
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:test',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox'],
          requested_network_mode: 'unrestricted',
          input: {},
        },
        { initiator: AGENT_INITIATOR, correlation_id: 'corr_unauth_net' },
      );
      assert.equal(netRes.ok, false);
      if (!netRes.ok) assert.equal(netRes.code, 'UNRESTRICTED_NETWORK_FORBIDDEN');

      const paidAiRes = h.engine.submitExecution(
        {
          task_id: 'task_unauth_paid_ai',
          title: 'Paid AI egress',
          description: 'Attempt calling api.openai.com.',
          agent: createAgent({ permitted_autonomy_level: 'L3' }),
          tools: [createTool({ permission_scope: 'net:egress:approved' })],
          requested_action: 'external:api_call',
          resource_id: 'net:openai',
          environment: 'local',
          declared_scopes: ['net:egress:approved'],
          requested_network_mode: 'allowlisted_endpoints',
          requested_network_urls: ['https://api.openai.com/v1/chat/completions'],
          input: {},
        },
        { initiator: AGENT_INITIATOR, correlation_id: 'corr_unauth_paid' },
      );
      assert.equal(paidAiRes.ok, false);
      if (!paidAiRes.ok) assert.equal(paidAiRes.code, 'PAID_THIRD_PARTY_AI_API_FORBIDDEN');

      // f) Agent privilege escalation / permission modification blocked
      const privRes = h.engine.submitExecution(
        {
          task_id: 'task_unauth_priv',
          title: 'Grant self permission',
          description: 'Attempt modifying permissions.',
          agent: createAgent({ permitted_autonomy_level: 'L3' }),
          tools: [createTool({ permission_scope: 'governance:grant' })],
          requested_action: 'permission:grant',
          resource_id: 'rbac:agent_eng_01',
          environment: 'local',
          declared_scopes: ['governance:grant'],
          input: {},
        },
        { initiator: AGENT_INITIATOR, correlation_id: 'corr_unauth_priv' },
      );
      assert.equal(privRes.ok, false);
      if (!privRes.ok) assert.equal(privRes.code, 'AGENT_SELF_PERMISSION_FORBIDDEN');

      const deniedLogs = h.engine.listExecutionLogs({ taskId: 'task_unauth_priv' });
      assert.equal(deniedLogs.length, 1);
      assert.equal(deniedLogs[0]?.outcome, 'denied');
    } finally {
      h.store.close();
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('3. pauses L3 and owner-sensitive L4 actions in Approval Inbox and executes only after owner approval', async () => {
    const h = createTestHarness();
    try {
      const seoAgent = createAgent({
        id: 'agent_seo_01',
        department: 'seo',
        role: 'seo_publisher',
        permitted_autonomy_level: 'L3',
        allowed_tool_ids: ['tool_publish_public', 'tool_deploy_staging'],
      });
      const publishTool = createTool({
        id: 'tool_publish_public',
        category: 'publishing',
        permission_scope: 'publish:public',
        risk_level: 'critical',
      });

      // Step 1: Request public publishing without approval -> enters Approval Inbox
      const firstAttempt = h.engine.submitExecution(
        {
          task_id: 'task_publish_01',
          title: 'Publish SEO landing update',
          description: 'Publish reviewed docs page to public site.',
          agent: seoAgent,
          tools: [publishTool],
          requested_action: 'publish:public',
          resource_id: 'site:docs.overview',
          environment: 'production',
          declared_scopes: ['publish:public'],
          input: { page: 'overview' },
        },
        { initiator: OWNER_ACTOR, correlation_id: 'corr_pub_1' },
      );

      assert.equal(firstAttempt.ok, false);
      if (firstAttempt.ok) return;
      assert.equal(firstAttempt.decision, 'require_approval');
      assert.ok(firstAttempt.approval_id);

      const pendingApproval = h.approvals.getApproval(firstAttempt.approval_id!);
      assert.equal(pendingApproval?.status, 'pending');

      // Step 2: Designated human owner approves in Approval Inbox
      const decideRes = h.approvals.decideApproval({
        approval_id: firstAttempt.approval_id!,
        decision: 'approved',
        reviewer: OWNER_REVIEWER,
        reason: 'Reviewed content and approved single-use public publish.',
        correlation_id: 'corr_pub_decide',
      });
      assert.equal(decideRes.ok, true);

      // Step 3: Re-submit with granted approval_id -> consumes approval and queues job
      const secondAttempt = h.engine.submitExecution(
        {
          task_id: 'task_publish_01',
          title: 'Publish SEO landing update',
          description: 'Publish reviewed docs page to public site.',
          agent: seoAgent,
          tools: [publishTool],
          requested_action: 'publish:public',
          resource_id: 'site:docs.overview',
          environment: 'production',
          declared_scopes: ['publish:public'],
          approval_id: firstAttempt.approval_id,
          input: { page: 'overview' },
        },
        { initiator: OWNER_ACTOR, correlation_id: 'corr_pub_2' },
      );

      assert.equal(secondAttempt.ok, true);
      if (!secondAttempt.ok) return;
      assert.equal(secondAttempt.job.approval_id, firstAttempt.approval_id);

      const execRes = await h.engine.runJob(secondAttempt.job.job_id);
      assert.equal(execRes.job?.status, 'completed');

      const consumedApproval = h.approvals.getApproval(firstAttempt.approval_id!);
      assert.ok(consumedApproval?.consumed_at);
    } finally {
      h.store.close();
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('4. blocks approval bypass attempts (self-approval, forged approval, wrong scope, rejected/expired/reused approval)', () => {
    const h = createTestHarness();
    try {
      const deployAgent = createAgent({
        id: 'agent_deployer_01',
        permitted_autonomy_level: 'L3',
        allowed_tool_ids: ['tool_deploy_staging'],
      });
      const stagingTool = createTool({
        id: 'tool_deploy_staging',
        category: 'deployment',
        permission_scope: 'deploy:staging',
        risk_level: 'high',
      });

      // a) Agent cannot approve a pending request via ApprovalService
      const reqApproval = h.approvals.requestApproval({
        task_id: 'task_bypass_01',
        action: 'deploy:staging',
        requested_by: 'agent_deployer_01',
        environment: 'staging',
        reason: 'Deploy staging preview.',
        scope: {
          resources: ['env:staging-web'],
          permissions: ['deploy:staging'],
          single_use: true,
          expires_at: '2099-01-01T00:00:00Z',
        },
        correlation_id: 'corr_bypass_req',
      });
      assert.equal(reqApproval.ok, true);
      if (!reqApproval.ok) return;

      const agentSelfDecide = h.approvals.decideApproval({
        approval_id: reqApproval.record.id,
        decision: 'approved',
        reviewer: {
          actor_id: 'agent_deployer_01',
          actor_type: 'agent',
          authenticated: true,
          auth_source: 'agent-token',
        },
        reason: 'Self-approve attempt',
        correlation_id: 'corr_bypass_self',
      });
      assert.equal(agentSelfDecide.ok, false);
      if (!agentSelfDecide.ok) assert.equal(agentSelfDecide.code, 'AGENT_APPROVAL_FORBIDDEN');

      // b) Forged unpersisted inline approval claiming agent reviewed_by is rejected
      const forgedInline: Approval = {
        id: 'apr_forged_999',
        task_id: 'task_bypass_01',
        action: 'deploy:staging',
        requested_by: 'agent_deployer_01',
        requested_at: '2026-11-20T12:00:00Z',
        status: 'approved',
        reviewed_by: 'owner_primary',
        reviewed_at: '2026-11-20T12:01:00Z',
        reason: 'Forged inline object',
        environment: 'staging',
        scope: {
          resources: ['env:staging-web'],
          permissions: ['deploy:staging'],
          single_use: true,
          expires_at: '2099-01-01T00:00:00Z',
        },
      };
      const forgedRes = h.engine.submitExecution(
        {
          task_id: 'task_bypass_01',
          title: 'Deploy staging',
          description: 'Try forged inline approval.',
          agent: deployAgent,
          tools: [stagingTool],
          requested_action: 'deploy:staging',
          resource_id: 'env:staging-web',
          environment: 'staging',
          declared_scopes: ['deploy:staging'],
          approval: forgedInline,
          input: {},
        },
        { initiator: { ...AGENT_INITIATOR, id: 'agent_deployer_01', trusted_autonomy_level: 'L3' }, correlation_id: 'corr_forged' },
      );
      assert.equal(forgedRes.ok, false);
      if (!forgedRes.ok) assert.equal(forgedRes.code, 'APPROVAL_NOT_IN_STORE');

      // c) Wrong resource / wrong task ID with real owner-approved record is rejected, and single-use cannot be reused
      h.approvals.decideApproval({
        approval_id: reqApproval.record.id,
        decision: 'approved',
        reviewer: OWNER_REVIEWER,
        reason: 'Approved for staging-web only.',
        correlation_id: 'corr_owner_ok',
      });

      const wrongResourceRes = h.engine.submitExecution(
        {
          task_id: 'task_bypass_01',
          title: 'Wrong resource attempt',
          description: 'Try using approval for a different target.',
          agent: deployAgent,
          tools: [stagingTool],
          requested_action: 'deploy:staging',
          resource_id: 'env:other-target',
          environment: 'staging',
          declared_scopes: ['deploy:staging'],
          approval_id: reqApproval.record.id,
          input: {},
        },
        { initiator: { ...AGENT_INITIATOR, id: 'agent_deployer_01', trusted_autonomy_level: 'L3' }, correlation_id: 'corr_wrong_res' },
      );
      assert.equal(wrongResourceRes.ok, false);
      if (!wrongResourceRes.ok) assert.equal(wrongResourceRes.code, 'APPROVAL_RESOURCE_MISMATCH');

      // Valid use succeeds once
      const firstValid = h.engine.submitExecution(
        {
          task_id: 'task_bypass_01',
          title: 'Valid staging deploy',
          description: 'Consume approval once.',
          agent: deployAgent,
          tools: [stagingTool],
          requested_action: 'deploy:staging',
          resource_id: 'env:staging-web',
          environment: 'staging',
          declared_scopes: ['deploy:staging'],
          approval_id: reqApproval.record.id,
          input: {},
        },
        { initiator: { ...AGENT_INITIATOR, id: 'agent_deployer_01', trusted_autonomy_level: 'L3' }, correlation_id: 'corr_use_1' },
      );
      assert.equal(firstValid.ok, true);

      // Reusing same single-use approval fails closed
      const replayRes = h.engine.submitExecution(
        {
          task_id: 'task_bypass_01',
          title: 'Replay approval',
          description: 'Attempt reusing single-use approval.',
          agent: deployAgent,
          tools: [stagingTool],
          requested_action: 'deploy:staging',
          resource_id: 'env:staging-web',
          environment: 'staging',
          declared_scopes: ['deploy:staging'],
          approval_id: reqApproval.record.id,
          input: {},
        },
        { initiator: { ...AGENT_INITIATOR, id: 'agent_deployer_01', trusted_autonomy_level: 'L3' }, correlation_id: 'corr_replay' },
      );
      assert.equal(replayRes.ok, false);
      if (!replayRes.ok) assert.equal(replayRes.code, 'SINGLE_USE_APPROVAL_CONSUMED');
    } finally {
      h.store.close();
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('5. records clean failed state and error details when sandbox execution fails', async () => {
    const adapter = new MockSandboxAdapter({
      stepHandlers: {
        'analytics:sandbox:execute': async () => ({
          ok: false,
          error: {
            code: 'ANALYTICS_VALIDATION_ERROR',
            message: 'Input dataset schema mismatch.',
            retryable: false,
          },
        }),
      },
    });
    const h = createTestHarness({ adapter });
    try {
      const analyticsAgent = createAgent({
        id: 'agent_analytics_01',
        department: 'analytics',
        role: 'metrics_analyst',
      });
      const sub = h.engine.submitExecution(
        {
          task_id: 'task_fail_01',
          title: 'Analyze campaign metrics',
          description: 'Compute campaign conversion summary.',
          agent: analyticsAgent,
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:analytics',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox'],
          input: { dataset: 'invalid' },
        },
        { initiator: { ...AGENT_INITIATOR, id: 'agent_analytics_01' }, correlation_id: 'corr_fail_01' },
      );
      assert.equal(sub.ok, true);
      if (!sub.ok) return;

      const out = await h.engine.runJob(sub.job.job_id);
      assert.equal(out.job?.status, 'failed');
      assert.equal(out.job?.error?.code, 'ANALYTICS_VALIDATION_ERROR');
      assert.ok(out.job?.finished_at);
    } finally {
      h.store.close();
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('6. handles execution timeout and explicit owner cancellation safely', async () => {
    const adapter = new MockSandboxAdapter({
      stepHandlers: {
        'research:sandbox:execute': async (_ctx, signal) =>
          new Promise((resolve) => {
            const t = setTimeout(() => {
              resolve({ ok: true, result: { late: true } });
            }, 500);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resolve({
                  ok: false,
                  error: {
                    code: 'EXECUTION_ABORTED',
                    message: 'Aborted via signal.',
                    retryable: false,
                  },
                });
              },
              { once: true },
            );
          }),
      },
    });
    const h = createTestHarness({ adapter });
    try {
      const researchAgent = createAgent({
        id: 'agent_research_01',
        department: 'research',
        role: 'topic_researcher',
      });

      // Timeout case
      const timeoutSub = h.engine.submitExecution(
        {
          task_id: 'task_timeout_01',
          title: 'Slow research job',
          description: 'Hits 120ms sandbox timeout.',
          agent: researchAgent,
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:research',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox'],
          timeout_ms: 120,
          input: {},
        },
        { initiator: { ...AGENT_INITIATOR, id: 'agent_research_01' }, correlation_id: 'corr_to' },
      );
      assert.equal(timeoutSub.ok, true);
      if (!timeoutSub.ok) return;

      const toOutcome = await h.engine.runJob(timeoutSub.job.job_id);
      assert.equal(toOutcome.job?.status, 'failed');
      assert.equal(toOutcome.job?.error?.code, 'EXECUTION_TIMEOUT');

      // Cancellation case (agent cannot cancel, authenticated owner cancels running job cleanly)
      const cancelSub = h.engine.submitExecution(
        {
          task_id: 'task_cancel_01',
          title: 'Cancellable research job',
          description: 'Cancelled mid-flight by owner.',
          agent: researchAgent,
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:research',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox'],
          timeout_ms: 5000,
          input: {},
        },
        { initiator: { ...AGENT_INITIATOR, id: 'agent_research_01' }, correlation_id: 'corr_can' },
      );
      assert.equal(cancelSub.ok, true);
      if (!cancelSub.ok) return;

      const agentCancel = h.engine.cancelJob({
        jobId: cancelSub.job.job_id,
        actor: AGENT_INITIATOR,
        reason: 'Agent should not cancel',
        correlation_id: 'corr_can_deny',
      });
      assert.equal(agentCancel.ok, false);

      const runningPromise = h.engine.runJob(cancelSub.job.job_id);
      await new Promise((r) => setTimeout(r, 20));
      const ownerCancel = h.engine.cancelJob({
        jobId: cancelSub.job.job_id,
        actor: OWNER_ACTOR,
        reason: 'Owner stopped job',
        correlation_id: 'corr_can_ok',
      });
      assert.equal(ownerCancel.ok, true);

      const runDone = await runningPromise;
      assert.equal(runDone.job?.status, 'cancelled');
    } finally {
      h.store.close();
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('7. enforces bounded retry limits and idempotency duplicate prevention', async () => {
    let attempts = 0;
    const adapter = new MockSandboxAdapter({
      stepHandlers: {
        'content:sandbox:execute': async () => {
          attempts += 1;
          return {
            ok: false,
            error: {
              code: 'TRANSIENT_STEP_ERROR',
              message: `Transient failure #${attempts}`,
              retryable: true,
            },
          };
        },
      },
    });
    const h = createTestHarness({ adapter });
    try {
      const contentAgent = createAgent({
        id: 'agent_content_01',
        department: 'content',
        role: 'content_drafter',
      });

      const sub1 = h.engine.submitExecution(
        {
          task_id: 'task_retry_01',
          title: 'Draft content',
          description: 'Bounded retry test.',
          agent: contentAgent,
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:content',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox'],
          idempotency_key: 'idem_content_01',
          max_retries: 2,
          input: {},
        },
        { initiator: { ...AGENT_INITIATOR, id: 'agent_content_01' }, correlation_id: 'corr_retry_1' },
      );
      assert.equal(sub1.ok, true);
      if (!sub1.ok) return;

      // Duplicate submission returns existing job without creating another
      const subDup = h.engine.submitExecution(
        {
          task_id: 'task_retry_01',
          title: 'Draft content',
          description: 'Duplicate request.',
          agent: contentAgent,
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:content',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox'],
          idempotency_key: 'idem_content_01',
          max_retries: 2,
          input: {},
        },
        { initiator: { ...AGENT_INITIATOR, id: 'agent_content_01' }, correlation_id: 'corr_retry_dup' },
      );
      assert.equal(subDup.ok, true);
      if (!subDup.ok) return;
      assert.equal(subDup.duplicate, true);
      assert.equal(subDup.job.job_id, sub1.job.job_id);

      // Run 1 -> fails & re-queues (retry_count = 1)
      const r1 = await h.engine.runJob(sub1.job.job_id);
      assert.equal(r1.retried, true);
      assert.equal(r1.job?.status, 'queued');
      assert.equal(r1.job?.retry_count, 1);

      // Run 2 -> fails & re-queues (retry_count = 2)
      const r2 = await h.engine.runJob(sub1.job.job_id);
      assert.equal(r2.retried, true);
      assert.equal(r2.job?.status, 'queued');
      assert.equal(r2.job?.retry_count, 2);

      // Run 3 -> retry limit exhausted -> terminal failed
      const r3 = await h.engine.runJob(sub1.job.job_id);
      assert.equal(r3.retried, false);
      assert.equal(r3.job?.status, 'failed');
      assert.equal(attempts, 3);
    } finally {
      h.store.close();
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('8. persists jobs and logs across application restarts and recovers interrupted running jobs safely', async () => {
    const dir = makeTempDir('tejaura-stage4-restart-');
    const dbPath = path.join(dir, 'restart.db');
    fs.mkdirSync(path.join(dir, 'sandbox'), { recursive: true });

    let completedJobId = '';
    let interruptedJobId = '';

    // Boot #1: Create a completed job and simulate an interrupted "running" job
    {
      const h1 = createTestHarness({ dir, workspaceRoot: dir, dbPath } as unknown as {
        dbPath: string;
        workspaceRoot: string;
      });
      const agent = createAgent({
        id: 'agent_design_01',
        department: 'design',
        role: 'ui_spec_helper',
      });

      const s1 = h1.engine.submitExecution(
        {
          task_id: 'task_persist_done',
          title: 'Completed job',
          description: 'Must survive restart.',
          agent,
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:design',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox'],
          input: { view: 'mobile' },
        },
        { initiator: { ...AGENT_INITIATOR, id: 'agent_design_01' }, correlation_id: 'corr_p1' },
      );
      assert.equal(s1.ok, true);
      if (!s1.ok) return;
      completedJobId = s1.job.job_id;
      await h1.engine.runJob(completedJobId);

      // Simulate crash while a retryable job was in "running" state
      const s2 = h1.engine.submitExecution(
        {
          task_id: 'task_persist_crash',
          title: 'Interrupted job',
          description: 'Simulate process crash while running.',
          agent,
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:design',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox'],
          max_retries: 1,
          idempotent_action: true,
          input: { view: 'crash-recovery' },
        },
        { initiator: { ...AGENT_INITIATOR, id: 'agent_design_01' }, correlation_id: 'corr_p2' },
      );
      assert.equal(s2.ok, true);
      if (!s2.ok) return;
      interruptedJobId = s2.job.job_id;

      const claimed = h1.store.claimAgentExecutionJob({
        jobId: interruptedJobId,
        nowIso: new Date().toISOString(),
      });
      assert.equal(claimed?.status, 'running');
      h1.store.close();
    }

    // Boot #2: New store + new AgentExecutionEngine instance
    {
      const h2 = createTestHarness({ dbPath, workspaceRoot: dir });
      try {
        const recovery = h2.engine.recoverOnStartup();
        assert.equal(recovery.recovered_count, 1);
        assert.deepEqual(recovery.requeued_job_ids, [interruptedJobId]);

        const persistedDone = h2.engine.getJob(completedJobId);
        assert.equal(persistedDone?.status, 'completed');

        const recoveredJob = h2.engine.getJob(interruptedJobId);
        assert.equal(recoveredJob?.status, 'queued');
        assert.equal(recoveredJob?.retry_count, 1);

        // Recovered job can now execute to completion on new process
        const runRecovered = await h2.engine.runJob(interruptedJobId);
        assert.equal(runRecovered.job?.status, 'completed');

        const persistedLogs = h2.engine.listExecutionLogs({ jobId: interruptedJobId });
        assert.ok(persistedLogs.some((l) => /Recovered interrupted/i.test(l.summary)));
      } finally {
        h2.store.close();
      }
    }

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('9. strictly redacts secrets from inputs, outputs, errors, and structured execution logs', async () => {
    const masterSecret = 'super-secret-master-key-value-999';
    const adapter = new MockSandboxAdapter({
      knownSecretValues: [masterSecret],
      stepHandlers: {
        'customer_support:sandbox:execute': async () => ({
          ok: false,
          error: {
            code: 'UPSTREAM_ERROR',
            message: `Failed with token Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig and key sk-testsecret1234567890 and ${masterSecret}`,
            retryable: false,
          },
        }),
      },
    });
    const h = createTestHarness({
      adapter,
      knownSecretValues: [masterSecret],
    });
    try {
      const supportAgent = createAgent({
        id: 'agent_support_01',
        department: 'customer_support',
        role: 'ticket_triager',
      });

      const sub = h.engine.submitExecution(
        {
          task_id: 'task_redact_01',
          title: 'Triage support note',
          description: 'Must scrub secrets everywhere.',
          agent: supportAgent,
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:support',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox'],
          input: {
            password: 'UserPassword123!',
            api_key: 'sk-abcdef1234567890abcdef',
            note: `Please check ${masterSecret}`,
          },
        },
        { initiator: { ...AGENT_INITIATOR, id: 'agent_support_01' }, correlation_id: 'corr_redact' },
      );
      assert.equal(sub.ok, true);
      if (!sub.ok) return;

      // Job input already scrubbed before SQLite insert
      assert.equal(sub.job.input.password, '[REDACTED_SECRET]');
      assert.equal(sub.job.input.api_key, '[REDACTED_SECRET]');
      assert.equal(String(sub.job.input.note).includes(masterSecret), false);

      const outcome = await h.engine.runJob(sub.job.job_id);
      assert.equal(outcome.job?.status, 'failed');
      const errMsg = outcome.job?.error?.message ?? '';
      assert.equal(errMsg.includes('eyJhbGciOiJIUzI1NiJ9'), false);
      assert.equal(errMsg.includes('sk-testsecret1234567890'), false);
      assert.equal(errMsg.includes(masterSecret), false);
      assert.match(errMsg, /\[REDACTED_SECRET\]/);

      const logs = h.engine.listExecutionLogs({ jobId: sub.job.job_id });
      const rawLogsJson = JSON.stringify(logs);
      assert.equal(rawLogsJson.includes('UserPassword123!'), false);
      assert.equal(rawLogsJson.includes('sk-testsecret1234567890'), false);
      assert.equal(rawLogsJson.includes(masterSecret), false);
      assert.ok(logs.some((l) => l.secrets_redacted === true));
    } finally {
      h.store.close();
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('10. exposes Stage 4 execution jobs and logs over RBAC-protected control plane HTTP endpoints', async () => {
    const stateDir = makeTempDir('tejaura-stage4-http-');
    const bundle = createControlPlaneApp({
      stateDir,
      environment: 'development',
      masterKeyMaterial: 'test-stage4-master-key-material-32chars',
    });

    const server = bundle.app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind ephemeral port.');
    }
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Unauthenticated request denied
      const unauthRes = await fetch(`${baseUrl}/api/execution/jobs`);
      assert.equal(unauthRes.status, 401);

      // Setup + login owner
      const setupRes = await fetch(`${baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tejaura-csrf': '1',
          origin: baseUrl,
        },
        body: JSON.stringify({
          username: 'owner_s4',
          email: 'owner@tejaura.local',
          password: 'CorrectHorseBatteryStaple!2026',
        }),
      });
      assert.equal(setupRes.status, 201);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tejaura-csrf': '1',
          origin: baseUrl,
        },
        body: JSON.stringify({
          identifier: 'owner_s4',
          password: 'CorrectHorseBatteryStaple!2026',
        }),
      });
      assert.equal(loginRes.status, 200);
      const setCookie = loginRes.headers.get('set-cookie')!;
      const cookieHeader = setCookie.split(';')[0]!;

      // Enqueue & run a Stage 4 job via executionEngine
      const sub = bundle.executionEngine.submitExecution(
        {
          task_id: 'task_http_s4',
          title: 'HTTP visibility job',
          description: 'Verify control plane visibility.',
          agent: createAgent(),
          tools: [createTool()],
          requested_action: 'sandbox:execute',
          resource_id: 'sandbox:http',
          environment: 'sandbox',
          declared_scopes: ['exec:run:sandbox'],
          input: { check: true },
        },
        { initiator: AGENT_INITIATOR, correlation_id: 'corr_http_s4' },
      );
      assert.equal(sub.ok, true);
      if (!sub.ok) return;
      await bundle.executionEngine.runJob(sub.job.job_id);

      const adaptersRes = await fetch(`${baseUrl}/api/execution/adapters`, {
        headers: { cookie: cookieHeader },
      });
      assert.equal(adaptersRes.status, 200);
      const adaptersBody = (await adaptersRes.json()) as {
        ok: boolean;
        adapters: Array<{ providerId: string; supportsOsIsolation: boolean }>;
      };
      assert.equal(adaptersBody.adapters[0]?.providerId, 'mock_sandbox_v1');
      assert.equal(adaptersBody.adapters[0]?.supportsOsIsolation, false);

      const jobsRes = await fetch(`${baseUrl}/api/execution/jobs`, {
        headers: { cookie: cookieHeader },
      });
      assert.equal(jobsRes.status, 200);
      const jobsBody = (await jobsRes.json()) as {
        ok: boolean;
        jobs: Array<{ job_id: string; status: string }>;
      };
      assert.equal(jobsBody.jobs[0]?.job_id, sub.job.job_id);
      assert.equal(jobsBody.jobs[0]?.status, 'completed');

      const logsRes = await fetch(`${baseUrl}/api/execution/logs?job_id=${sub.job.job_id}`, {
        headers: { cookie: cookieHeader },
      });
      assert.equal(logsRes.status, 200);
      const logsBody = (await logsRes.json()) as {
        ok: boolean;
        logs: Array<{ outcome: string }>;
      };
      assert.ok(logsBody.logs.length >= 2);
    } finally {
      server.close();
      bundle.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
