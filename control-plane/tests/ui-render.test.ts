import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentsManagementView } from '../../src/components/AgentsManagementView.tsx';
import { AIWorkforceView } from '../../src/components/AIWorkforceView.tsx';
import { ApprovalInboxView } from '../../src/components/ApprovalInboxView.tsx';
import { AuditCenterView } from '../../src/components/AuditCenterView.tsx';
import { AuthScreen } from '../../src/components/AuthScreen.tsx';
import { ModelsRuntimesView } from '../../src/components/ModelsRuntimesView.tsx';
import { OverviewView } from '../../src/components/OverviewView.tsx';
import { PolicyInspectorView } from '../../src/components/PolicyInspectorView.tsx';
import { ProjectsManagementView } from '../../src/components/ProjectsManagementView.tsx';
import { SecuritySettingsView } from '../../src/components/SecuritySettingsView.tsx';
import { SystemAdminView } from '../../src/components/SystemAdminView.tsx';
import { TaskCenterView } from '../../src/components/TaskCenterView.tsx';
import type {
  ApprovalItem,
  AuditLogItem,
  ComputeNodeItem,
  ManagedAgentItem,
  ManagedProjectItem,
  ModelInventoryItem,
  OrchestratedTask,
  SystemAdminOverview,
  SystemOverviewResponse,
} from '../../src/types/controlPlane.ts';

function sampleOverview(): SystemOverviewResponse {
  return {
    ok: true,
    generated_at: '2026-11-20T12:00:00.000Z',
    owner: {
      owner_id: 'owner_primary',
      username: 'ritesh_owner',
      role: 'owner',
      session_id: 'sess_123456',
      expires_at: '2026-11-20T20:00:00.000Z',
      idle_expires_at: '2026-11-20T12:30:00.000Z',
    },
    persistence: {
      engine: 'sqlite',
      migrations_applied: [{ version: 1, name: 'stage3_core_schema', applied_at: '2026-11-20T12:00:00Z' }],
    },
    worker: {
      worker_id: 'worker_1',
      active_leases: 0,
      lifecycle: {
        active_global: 0,
        max_concurrent_global: 2,
        max_concurrent_per_model: 1,
        queued_count: 0,
        max_queue_size: 20,
        open_circuits: [],
      },
      primary_runtime: 'airllm',
      paid_api_fallback_enabled: false,
    },
    counts: {
      tasks_by_status: {
        queued: 1,
        running: 0,
        waiting_for_approval: 1,
        succeeded: 2,
        failed: 0,
        cancelled: 0,
      },
      total_tasks: 4,
      pending_approvals: 1,
      active_schedules: 1,
      total_schedules: 1,
      registered_models: 1,
      verified_enabled_models: 1,
      online_compute_nodes: 1,
      trusted_endpoints: 1,
    },
    action_catalog: [
      {
        action: 'governance:read',
        required_autonomy: 'L0',
        required_scope: 'governance:read',
        owner_exclusive: false,
        allowed_environments: ['local'],
        description: 'Inspect governance and policy state.',
      },
    ],
    trusted_endpoints: [
      {
        endpoint_id: 'airllm_primary_worker',
        runtime_type: 'airllm',
        base_url: 'http://127.0.0.1:8787',
        node_id: 'local_host_airllm',
        enabled: true,
        requires_auth: true,
        auth_token_env_var: 'TEJAURA_AIRLLM_WORKER_TOKEN',
      },
    ],
    secrets_inventory: [
      {
        key: 'TEJAURA_AIRLLM_WORKER_TOKEN',
        source: 'environment',
        scope: 'runtime:airllm',
        present: true,
        updated_at: null,
      },
    ],
    system_governance: {
      system: { name: 'TEJAURA' },
      principles: { localFirst: true },
      governance: {
        humanOwnerControl: true,
        allowAgentSelfPermission: false,
        allowAgentSelfApproval: false,
        failClosedOnPolicyError: true,
        defaultAutonomyLevel: 'L1',
        maxAutonomousLevel: 'L2',
        autonomyLevels: {
          L0: { id: 'observe', description: 'Read-only observation.' },
          L1: { id: 'propose', description: 'Draft proposals only.' },
          L2: { id: 'bounded', description: 'Bounded sandbox execution.' },
          L3: { id: 'supervised', description: 'Owner-approved supervised actions.' },
          L4: { id: 'owner_exclusive', description: 'Owner-exclusive sensitive operations.' },
        },
      },
      approval_gates: {
        productionDeploy: { required: true, autonomyLevel: 'L4', allowAutoApprove: false },
      },
      security: null,
    },
    rbac_roles: {
      owner: ['governance:read', 'governance:write', 'approval:decide'],
      readonly_viewer: ['governance:read'],
    },
    auth_posture: {
      mfa_enrolled_count: 1,
      recovery_codes_remaining: 8,
      active_sessions_count: 1,
      cookie_name: '__Host-tejaura_session',
      same_site: 'Strict',
      http_only: true,
      secure_cookie: true,
      enforce_https_in_deployment: true,
    },
  };
}

describe('Stage 3 — Frontend UI Rendering & Secret Non-Exposure Guard', () => {
  it('renders uninitialized Setup screen and initialized Login screen cleanly', () => {
    const setupHtml = renderToStaticMarkup(
      React.createElement(AuthScreen, {
        initialized: false,
        onAuthenticated: () => {},
        onSetupCompleted: () => {},
      }),
    );
    assert.match(setupHtml, /Initial Owner Account Setup/);
    assert.match(setupHtml, /Argon2id/);

    const loginHtml = renderToStaticMarkup(
      React.createElement(AuthScreen, {
        initialized: true,
        sessionNotice: 'Session expired cleanly.',
        onAuthenticated: () => {},
        onSetupCompleted: () => {},
      }),
    );
    assert.match(loginHtml, /Authenticate Owner Session/);
    assert.match(loginHtml, /Session expired cleanly/);
    assert.match(loginHtml, /Account Recovery/);
  });

  it('renders Overview, Approval Inbox, Task Center, Models, Policy, Audit, and Security Settings without exposing secret values', () => {
    const overview = sampleOverview();
    const task: OrchestratedTask = {
      id: 'task_123456',
      type: 'external:api_call',
      title: 'Staging Webhook Dispatch',
      description: 'Verify webhook endpoint.',
      status: 'waiting_for_approval',
      autonomy_level: 'L3',
      environment: 'staging',
      action: 'external:api_call',
      resource_id: 'webhook:staging',
      declared_scopes: ['net:egress:approved'],
      priority: 80,
      idempotency_key: null,
      idempotent_action: false,
      deadline_at: null,
      retry_count: 0,
      max_retries: 1,
      timeout_ms: 10000,
      next_run_at: '2026-11-20T12:00:00.000Z',
      schedule_id: null,
      requested_by: 'owner_primary',
      assigned_agent_id: null,
      input: {},
      result: null,
      error: null,
      approval_ids: ['apr_123'],
      created_at: '2026-11-20T12:00:00.000Z',
      updated_at: '2026-11-20T12:00:00.000Z',
    };
    const approval: ApprovalItem = {
      id: 'apr_123',
      task_id: task.id,
      action: 'external:api_call',
      requested_by: 'tejaura_execution_pipeline',
      requested_at: '2026-11-20T12:00:00.000Z',
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      reason: 'Staging Webhook Dispatch: Verify webhook endpoint.',
      scope: {
        resources: ['webhook:staging'],
        permissions: ['net:egress:approved'],
        single_use: true,
        expires_at: '2026-11-21T12:00:00.000Z',
      },
      environment: 'staging',
      consumed_at: null,
      consumed_for_task_id: null,
    };
    const model: ModelInventoryItem = {
      model_id: 'llama-3.1-70b-airllm',
      model_name: 'Meta-Llama-3.1-70B-Instruct',
      model_family: 'llama3.1',
      model_version: '70b-instruct',
      runtime_type: 'airllm',
      compatibility_status: 'verified',
      modality: 'text',
      capabilities: ['chat'],
      quantization: '4bit',
      context_length: 32768,
      enabled: true,
      availability: 'available',
      controlled_runtime_endpoint: 'http://127.0.0.1:8787',
      breaker: { consecutive_failures: 0, circuit_open: false },
      best_node_fit: { fits: true, code: 'FIT_OK', reason: 'Compatible GPU node' },
    };
    const node: ComputeNodeItem = {
      node_id: 'local_host_airllm',
      name: 'Owner Local Node',
      location: 'local',
      online: true,
      has_gpu: false,
      total_ram_mb: 16384,
      available_ram_mb: 12288,
      total_vram_mb: 0,
      available_vram_mb: 0,
      supported_runtimes: ['airllm'],
      last_seen_at: '2026-11-20T12:00:00.000Z',
    };
    const auditEvent: AuditLogItem = {
      id: 'aud_1',
      timestamp: '2026-11-20T12:00:00.000Z',
      actor_type: 'owner',
      actor_id: 'owner_primary',
      event_type: 'task.created',
      resource_type: 'task',
      resource_id: task.id,
      action: 'external:api_call',
      outcome: 'pending',
      approval_id: approval.id,
    };

    const overviewHtml = renderToStaticMarkup(
      React.createElement(OverviewView, {
        overview,
        tasks: [task],
        models: [model],
        computeNodes: [node],
        loading: false,
        tickBusy: false,
        onRefresh: () => {},
        onRunWorkerTick: () => {},
        onOpenNewTask: () => {},
        onSelectTask: () => {},
        onNavigateTab: () => {},
      }),
    );
    assert.match(overviewHtml, /System Overview/);
    assert.match(overviewHtml, /Primary runtime: airllm/);
    assert.match(overviewHtml, /Run Worker Tick/);

    const approvalHtml = renderToStaticMarkup(
      React.createElement(ApprovalInboxView, {
        approvals: [approval],
        loading: false,
        onRefresh: async () => {},
        onSelectTask: () => {},
      }),
    );
    assert.match(approvalHtml, /Owner Decision Reason \(Required\)/);
    assert.match(approvalHtml, /Approve Request/);
    assert.match(approvalHtml, /Reject Request/);

    const taskHtml = renderToStaticMarkup(
      React.createElement(TaskCenterView, {
        tasks: [task],
        actionCatalog: overview.action_catalog,
        selectedTaskId: null,
        loading: false,
        showNewTaskModal: false,
        onCloseNewTaskModal: () => {},
        onOpenNewTaskModal: () => {},
        onSelectTask: () => {},
        onRefresh: async () => {},
      }),
    );
    assert.match(taskHtml, /Staging Webhook Dispatch/);

    const modelsHtml = renderToStaticMarkup(
      React.createElement(ModelsRuntimesView, {
        primaryRuntime: 'airllm',
        models: [model],
        computeNodes: [node],
        trustedEndpoints: overview.trusted_endpoints,
        loading: false,
      }),
    );
    assert.match(modelsHtml, /Probe Availability/);
    assert.match(modelsHtml, /Paid third-party API fallback is disabled/);

    const policyHtml = renderToStaticMarkup(
      React.createElement(PolicyInspectorView, { overview }),
    );
    assert.match(policyHtml, /L0 · observe/);
    assert.match(policyHtml, /L4 · owner_exclusive/);

    const auditHtml = renderToStaticMarkup(
      React.createElement(AuditCenterView, {
        events: [auditEvent],
        loading: false,
        onRefresh: async () => {},
      }),
    );
    assert.match(auditHtml, /Read-only structured security and governance trail/);
    assert.match(auditHtml, /external:api_call/);

    const securityHtml = renderToStaticMarkup(
      React.createElement(SecuritySettingsView, {
        overview,
        loading: false,
        onRefresh: async () => {},
        onSignedOut: () => {},
      }),
    );
    assert.match(securityHtml, /Secret Key Inventory \(Presence Metadata Only\)/);
    assert.match(securityHtml, /TEJAURA_AIRLLM_WORKER_TOKEN/);
    assert.match(securityHtml, /Enroll TOTP Factor/);

    const sampleAgent: ManagedAgentItem = {
      id: 'agent_eng_1',
      name: 'Engineering Patch Bot',
      department: 'engineering',
      role: 'Sandboxed Engineer',
      description: 'Prepares verified staging patches.',
      status: 'active',
      enabled: true,
      permitted_autonomy_level: 'L2',
      allowed_tool_ids: ['workspace.read'],
      preferred_model_ids: [model.model_id],
      backup_model_ids: [],
      max_concurrent_jobs: 1,
      timeout_ms: 30000,
      allowed_paths: ['sandbox'],
      network_mode: 'none',
      last_health_status: 'healthy',
      created_by: 'owner_primary',
      created_at: '2026-11-20T12:00:00.000Z',
      updated_at: '2026-11-20T12:00:00.000Z',
      schema_version: '1.0.0',
    };
    const agentsHtml = renderToStaticMarkup(
      React.createElement(AgentsManagementView, {
        models: [model],
        initialAgents: [sampleAgent],
      }),
    );
    assert.match(agentsHtml, /Agent Management Center/);
    assert.match(agentsHtml, /Engineering Patch Bot/);

    const workforceHtml = renderToStaticMarkup(
      React.createElement(AIWorkforceView, { onOpenApprovals: () => {} }),
    );
    assert.match(workforceHtml, /AI Workforce/);
    assert.match(workforceHtml, /Department agents/);
    assert.match(workforceHtml, /Sandbox capabilities are unavailable/);

    const sampleProject: ManagedProjectItem = {
      project_id: 'proj_docs',
      name: 'TEJAURA Docs Portal',
      slug: 'tejaura-docs',
      project_type: 'website',
      description: 'Official docs site.',
      domain_url: 'https://staging.tejaura.local',
      workspace_path: 'projects/tejaura-docs',
      environment: 'staging',
      deployment_status: 'draft',
      health_status: 'unknown',
      assigned_agent_ids: [sampleAgent.id],
      recent_changes: [],
      recent_errors: [],
      pending_approval_id: null,
      last_deployed_at: null,
      created_by: 'owner_primary',
      created_at: '2026-11-20T12:00:00.000Z',
      updated_at: '2026-11-20T12:00:00.000Z',
    };
    const projectsHtml = renderToStaticMarkup(
      React.createElement(ProjectsManagementView, {
        agents: [sampleAgent],
        initialProjects: [sampleProject],
      }),
    );
    assert.match(projectsHtml, /Projects &amp; Websites/);
    assert.match(projectsHtml, /TEJAURA Docs Portal/);

    const sampleAdmin: SystemAdminOverview = {
      generated_at: '2026-11-20T12:00:00.000Z',
      database: {
        engine: 'sqlite',
        integrity_ok: true,
        integrity_message: 'ok',
        page_count: 16,
        page_size: 4096,
        estimated_bytes: 65536,
        table_counts: { tasks: 4, managed_agents: 1 },
      },
      migrations: overview.persistence.migrations_applied,
      storage: {
        state_dir_bytes: 131072,
        backups_dir_bytes: 0,
        db_estimated_bytes: 65536,
      },
      queue_health: {
        queued_tasks: 1,
        queued_agent_jobs: 0,
        active_leases: 0,
        recent_failed_tasks: 0,
        recent_failed_jobs: 0,
      },
      workers_summary: { total: 1, enabled: 1, online: 0, offline: 1 },
      config: {
        maintenance_mode: false,
        max_queue_depth: 20,
        auto_recover_leases: true,
        preferred_model_source: 'modelscope',
        default_model_id: model.model_id,
        backup_model_id: null,
      },
      backups: [],
    };
    const adminHtml = renderToStaticMarkup(
      React.createElement(SystemAdminView, {
        initialAdmin: sampleAdmin,
        initialLogs: [],
      }),
    );
    assert.match(adminHtml, /System Administration/);
    assert.match(adminHtml, /PASS \(ok\)/);
  });

  it('guarantees frontend source never persists secrets in localStorage or embeds server master/worker secrets', () => {
    const srcRoot = path.resolve(process.cwd(), 'src');
    const files: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full);
      }
    }

    walk(srcRoot);
    assert.ok(files.length >= 10);

    for (const filePath of files) {
      const contents = fs.readFileSync(filePath, 'utf8');
      assert.equal(
        /\blocalStorage\b|\bsessionStorage\b/.test(contents),
        false,
        `Browser storage forbidden in ${path.relative(srcRoot, filePath)}`,
      );
      assert.equal(
        contents.includes('TEJAURA_SECRETS_MASTER_KEY'),
        false,
        `Frontend must never reference master encryption key env var in ${path.relative(srcRoot, filePath)}`,
      );
    }
  });
});
