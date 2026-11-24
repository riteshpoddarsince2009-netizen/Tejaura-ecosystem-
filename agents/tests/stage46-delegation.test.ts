import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import systemConfig from '../../core/configuration/system.json' with { type: 'json' };
import { ApprovalService } from '../../core/approvals/index.ts';
import {
  AuditLogger,
  InMemoryAuditStorage,
} from '../../core/audit/index.ts';
import type { PolicyActor } from '../../core/policy/index.ts';
import {
  DEPARTMENT_AGENT_DEFINITIONS,
  DelegationEngine,
  SqliteDelegationStore,
  type DelegationSandboxExecutor,
} from '../index.ts';

const OWNER: PolicyActor = {
  id: 'owner_primary',
  type: 'owner',
  trusted_autonomy_level: 'L4',
  trusted_authenticated: true,
};

const AGENT_ACTOR: PolicyActor = {
  id: 'ceo_strategy',
  type: 'agent',
  trusted_autonomy_level: 'L2',
  trusted_authenticated: true,
};

class FakeSandboxExecutor implements DelegationSandboxExecutor {
  calls = 0;
  lastInput: Record<string, unknown> | null = null;

  async runEngineeringTask(params: {
    input: Record<string, unknown>;
  }): Promise<{
    ok: boolean;
    result?: Record<string, unknown>;
    error?: { code: string; message: string; retryable: boolean };
  }> {
    this.calls += 1;
    this.lastInput = params.input;
    return {
      ok: true,
      result: {
        changed_files: ['index.mjs', 'test.mjs'],
        test_evidence: {
          executed: true,
          command: 'node --test',
          exit_code: 0,
          output: '1..1\n# pass 1\n# fail 0',
          simulated: false,
        },
      },
    };
  }

  async getCapabilities(): Promise<Record<string, unknown>> {
    return {
      selected_provider: 'fake_isolated_container',
      os_isolated: true,
      simulated: false,
    };
  }
}

function makeHarness() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-stage46-'));
  const dbPath = path.join(stateDir, 'stage46.db');
  const clock = () => new Date('2026-11-24T08:00:00.000Z');
  const store = new SqliteDelegationStore({ dbPath });
  const auditLogger = new AuditLogger({
    storage: new InMemoryAuditStorage(),
    clock,
  });
  const approvals = new ApprovalService({
    designatedOwnerId: 'owner_primary',
    auditLogger,
    clock,
  });
  const sandbox = new FakeSandboxExecutor();
  const engine = new DelegationEngine({
    store,
    approvals,
    auditLogger,
    systemConfig,
    clock,
    sandboxExecutor: sandbox,
    maxConcurrentTasks: 2,
    maxTotalTasksPerProject: 40,
  });
  return {
    stateDir,
    store,
    engine,
    approvals,
    sandbox,
    close: () => store.close(),
  };
}

describe('TEJAURA Stage 4.6 — Department Agents & Multi-Agent Delegation', () => {
  const cleanups: Array<() => void> = [];
  after(() => {
    for (const cleanup of cleanups) cleanup();
  });

  it('defines ten distinct department agents with capabilities and scoped tools', () => {
    assert.equal(DEPARTMENT_AGENT_DEFINITIONS.length, 10);
    const ids = new Set(DEPARTMENT_AGENT_DEFINITIONS.map((agent) => agent.id));
    assert.equal(ids.size, 10);
    const capabilitySets = new Set(
      DEPARTMENT_AGENT_DEFINITIONS.map((agent) => agent.capabilities.join('|')),
    );
    assert.equal(capabilitySets.size, 10);
    assert.ok(ids.has('research'));
    assert.ok(!ids.has('watchdog'));
    for (const agent of DEPARTMENT_AGENT_DEFINITIONS) {
      assert.ok(agent.allowed_tool_ids.length > 0);
      assert.ok(agent.input_schema.endsWith('.json'));
      assert.ok(agent.output_schema.endsWith('.json'));
      assert.ok(agent.scopes.length > 0);
      assert.ok(!agent.scopes.includes('permission:grant'));
    }
    const ceo = DEPARTMENT_AGENT_DEFINITIONS.find((agent) => agent.id === 'ceo_strategy')!;
    assert.equal(ceo.allowed_delegate_ids.length, 9);
    assert.ok(!ceo.allowed_delegate_ids.includes('ceo_strategy'));
  });

  it('runs an end-to-end objective with real delegation, approval gating, QA and consolidation', async () => {
    const h = makeHarness();
    cleanups.push(h.close);
    const created = h.engine.createObjective(
      {
        name: 'Marketing website launch',
        objective:
          'Build a marketing website landing page, prepare SEO and content, and publish the announcement.',
        context: {
          brand: 'Tejaura',
          audience: 'builders',
          files: [{ path: 'test.mjs', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n" }],
        },
      },
      { actor: OWNER, correlation_id: 'corr_e2e' },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const firstRun = await h.engine.processQueue(20);
    assert.ok(firstRun.processed >= 5);
    const tasksAfterFirst = h.engine.listTasks({ projectId: created.data.project.project_id, limit: 100 });
    const contentTask = tasksAfterFirst.find((task) => task.agent_id === 'content_social');
    assert.ok(contentTask, 'content task should exist');
    assert.equal(contentTask!.status, 'WAITING_FOR_APPROVAL');
    assert.ok(contentTask!.approval_id);

    const agentReview = h.engine.decideDelegationApproval({
      approval_id: contentTask!.approval_id!,
      decision: 'approved',
      reviewer: {
        actor_id: 'content_social',
        actor_type: 'agent',
        authenticated: true,
        auth_source: 'agent-self',
      },
      reason: 'Agent self-approval attempt',
      correlation_id: 'corr_self_approve',
    });
    assert.equal(agentReview.ok, false);

    const ownerApproval = h.engine.decideDelegationApproval({
      approval_id: contentTask!.approval_id!,
      decision: 'approved',
      reviewer: {
        actor_id: 'owner_primary',
        actor_type: 'owner',
        authenticated: true,
        auth_source: 'owner-session',
      },
      reason: 'Approved for manual publication package release.',
      correlation_id: 'corr_owner_approve',
    });
    assert.equal(ownerApproval.ok, true);

    const secondRun = await h.engine.processQueue(20);
    assert.ok(secondRun.processed >= 2);
    const finalTasks = h.engine.listTasks({ projectId: created.data.project.project_id, limit: 100 });
    const approvedContent = finalTasks.find((task) => task.task_id === contentTask!.task_id)!;
    assert.equal(approvedContent.status, 'COMPLETED');
    const contentDeliverable = (
      approvedContent.output?.deliverables as Array<Record<string, unknown>>
    )[0];
    assert.equal(contentDeliverable?.kind, 'copy');
    const contentPackage = JSON.parse(String(contentDeliverable?.content ?? '{}')) as Record<
      string,
      unknown
    >;
    assert.equal(contentPackage.external_publish_executed, false);
    assert.equal(contentPackage.publication_status, 'approved_for_manual_publish');
    const consolidation = finalTasks.find(
      (task) => task.input.mode === 'consolidate',
    );
    assert.ok(consolidation, 'CEO consolidation task should exist');
    assert.equal(consolidation!.status, 'COMPLETED');
    const consolidationDeliverable = (
      consolidation!.output?.deliverables as Array<Record<string, unknown>>
    )[0];
    assert.equal(consolidationDeliverable?.name, 'Consolidated project report');
    assert.match(String(consolidationDeliverable?.content), /"verdict"/);
    assert.ok(h.sandbox.calls >= 1, 'engineering sandbox executor should be invoked');
    assert.equal(
      (h.sandbox.lastInput?.files as unknown[] | undefined)?.length,
      1,
      'owner-supplied files should reach the sandbox executor',
    );

    const qa = finalTasks.find((task) => task.agent_id === 'qa_reviewer')!;
    assert.equal(qa.status, 'COMPLETED');
    assert.ok(['pass', 'pass_with_findings'].includes(String(qa.output?.verdict)));
  });

  it('delegates bounded research synthesis using only supplied sources', async () => {
    const h = makeHarness();
    cleanups.push(h.close);
    const created = h.engine.createObjective(
      {
        name: 'Competitor research',
        objective:
          'Research the competitor landscape and prepare a market brief for the landing page.',
        context: {
          sources: [
            { id: 'src_1', title: 'Owner interview notes', notes: 'Buyers want faster setup.' },
          ],
        },
      },
      { actor: OWNER, correlation_id: 'corr_research' },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    await h.engine.processQueue(20);
    const research = h.engine
      .listTasks({ projectId: created.data.project.project_id, limit: 100 })
      .find((task) => task.agent_id === 'research');
    assert.ok(research, 'research task should exist');
    assert.equal(research!.status, 'COMPLETED');
    const researchMetadata = (research!.output?.metadata ?? {}) as Record<string, unknown>;
    assert.equal(researchMetadata.evidence_mode, 'supplied_sources_only');
    const deliverable = (research!.output?.deliverables as Array<Record<string, unknown>>)[0];
    const brief = JSON.parse(String(deliverable.content)) as Record<string, unknown>;
    assert.equal(brief.external_collection_executed, false);
    assert.equal(brief.source_count, 1);
    assert.equal(brief.confidence, 'low');
  });

  it('rejects agent-created objectives and duplicate idempotency keys are safe', () => {
    const h = makeHarness();
    cleanups.push(h.close);
    const denied = h.engine.createObjective(
      { name: 'Rogue project', objective: 'Agent attempts to create an owner objective.' },
      { actor: AGENT_ACTOR, correlation_id: 'corr_rogue' },
    );
    assert.equal(denied.ok, false);

    const first = h.engine.createObjective(
      {
        name: 'Idempotent project',
        objective: 'Create one analytics baseline report for the owner.',
        idempotency_key: 'idem-001',
      },
      { actor: OWNER, correlation_id: 'corr_idem_1' },
    );
    assert.equal(first.ok, true);
    const second = h.engine.createObjective(
      {
        name: 'Idempotent project',
        objective: 'Create one analytics baseline report for the owner.',
        idempotency_key: 'idem-001',
      },
      { actor: OWNER, correlation_id: 'corr_idem_2' },
    );
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(first.data.task.task_id, second.data.task.task_id);
      assert.equal(first.data.project.project_id, second.data.project.project_id);
    }

    const forbiddenContext = h.engine.createObjective(
      {
        name: 'Privilege context',
        objective: 'Attempt to inject privilege fields through objective context.',
        context: { permissions: ['governance:write'] },
      },
      { actor: OWNER, correlation_id: 'corr_priv_ctx' },
    );
    assert.equal(forbiddenContext.ok, false);
    if (!forbiddenContext.ok) {
      assert.equal(forbiddenContext.code, 'FORBIDDEN_CONTEXT_FIELDS');
    }

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 15; i += 1) deep = { nested: deep };
    const tooDeep = h.engine.createObjective(
      {
        name: 'Deep context',
        objective: 'Attempt to bypass validation with deeply nested context.',
        context: deep,
      },
      { actor: OWNER, correlation_id: 'corr_deep_ctx' },
    );
    assert.equal(tooDeep.ok, false);
    if (!tooDeep.ok) {
      assert.equal(tooDeep.code, 'FORBIDDEN_CONTEXT_FIELDS');
    }
  });

  it('fails closed on self-delegation, unknown actions, and privilege fields in messages', async () => {
    const cases: Array<{ name: string; delegation: Record<string, unknown>; code: string }> = [
      {
        name: 'self-delegation',
        delegation: {
          key: 'self',
          target_agent_id: 'ceo_strategy',
          title: 'Self delegate',
          description: 'Attempt to delegate to self.',
          action: 'agent:plan',
          input: {},
        },
        code: 'SELF_DELEGATION_FORBIDDEN',
      },
      {
        name: 'unknown action',
        delegation: {
          key: 'bad-action',
          target_agent_id: 'engineering',
          title: 'Bad action',
          description: 'Attempt an action the target cannot perform.',
          action: 'permission:grant',
          input: {},
        },
        code: 'ACTION_NOT_ALLOWED_FOR_DELEGATE',
      },
      {
        name: 'privilege fields',
        delegation: {
          key: 'privilege',
          target_agent_id: 'engineering',
          title: 'Privilege attempt',
          description: 'Attempt to smuggle permissions through task input.',
          action: 'agent:write_code',
          input: { permissions: ['governance:write'] },
        },
        code: 'FORBIDDEN_DELEGATION_FIELDS',
      },
    ];

    for (const testCase of cases) {
      const h = makeHarness();
      cleanups.push(h.close);
      const originalPlan = (h.engine as unknown as { planObjective: unknown }).planObjective;
      (h.engine as unknown as { planObjective: unknown }).planObjective = () => ({
        status: 'completed',
        summary: 'Malicious plan for validation testing.',
        deliverables: [{ name: 'plan', kind: 'plan', content: '{}' }],
        delegations: [testCase.delegation],
        model_assisted: false,
      });
      const created = h.engine.createObjective(
        {
          name: `Security case ${testCase.name}`,
          objective: 'Exercise delegation validation with a hostile agent message.',
        },
        { actor: OWNER, correlation_id: `corr_${testCase.name}` },
      );
      assert.equal(created.ok, true);
      if (!created.ok) continue;
      await h.engine.processQueue(3);
      const root = h.engine.getTask(created.data.task.task_id)!;
      assert.equal(root.status, 'FAILED', testCase.name);
      assert.equal(root.error?.code, testCase.code, testCase.name);
      (h.engine as unknown as { planObjective: unknown }).planObjective = originalPlan;
    }
  });

  it('rejects cyclic delegation dependencies', async () => {
    const h = makeHarness();
    cleanups.push(h.close);
    const originalPlan = (h.engine as unknown as { planObjective: unknown }).planObjective;
    (h.engine as unknown as { planObjective: unknown }).planObjective = () => ({
      status: 'completed',
      summary: 'Cyclic plan for validation testing.',
      deliverables: [{ name: 'plan', kind: 'plan', content: '{}' }],
      delegations: [
        {
          key: 'design-step',
          target_agent_id: 'design',
          title: 'Design step',
          description: 'Design work that depends on engineering.',
          action: 'agent:design',
          input: {},
          depends_on_keys: ['engineering-step'],
        },
        {
          key: 'engineering-step',
          target_agent_id: 'engineering',
          title: 'Engineering step',
          description: 'Engineering work that depends on design.',
          action: 'agent:write_code',
          input: {},
          depends_on_keys: ['design-step'],
        },
      ],
      model_assisted: false,
    });
    const created = h.engine.createObjective(
      {
        name: 'Cycle project',
        objective: 'Exercise dependency cycle validation with a hostile plan.',
      },
      { actor: OWNER, correlation_id: 'corr_cycle' },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    await h.engine.processQueue(3);
    const root = h.engine.getTask(created.data.task.task_id)!;
    assert.equal(root.status, 'FAILED');
    assert.equal(root.error?.code, 'DELEGATION_DEPENDENCY_CYCLE');
    (h.engine as unknown as { planObjective: unknown }).planObjective = originalPlan;
  });

  it('records watchdog alerts and recovers interrupted tasks without claiming success', () => {
    const h = makeHarness();
    cleanups.push(h.close);
    const created = h.engine.createObjective(
      { name: 'Watchdog project', objective: 'Monitor the task queue for stuck work.' },
      { actor: OWNER, correlation_id: 'corr_watchdog' },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const claimed = h.store.claimTask(created.data.task.task_id, new Date().toISOString());
    assert.ok(claimed);
    const recovered = h.engine.recoverOnStartup();
    assert.ok(recovered.requeued.includes(created.data.task.task_id));
    const task = h.engine.getTask(created.data.task.task_id)!;
    assert.equal(task.status, 'QUEUED');
    assert.equal(task.retry_count, 1);
    const claimedAgain = h.store.claimTask(created.data.task.task_id, new Date().toISOString());
    assert.ok(claimedAgain);
    const recoveredAgain = h.engine.recoverOnStartup();
    assert.ok(recoveredAgain.failed.includes(created.data.task.task_id));
    const failedTask = h.engine.getTask(created.data.task.task_id)!;
    assert.equal(failedTask.status, 'FAILED');
    assert.equal(failedTask.error?.code, 'RECOVERY_LIMIT_EXCEEDED');
    const alerts = h.engine.watchdogScan();
    assert.ok(Array.isArray(alerts));
  });
});
