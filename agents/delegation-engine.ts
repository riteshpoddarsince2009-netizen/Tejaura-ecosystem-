import crypto from 'node:crypto';

import type { Agent, ExecutionEnvironment } from '../contracts/types/index.ts';
import type { ApprovalRecord } from '../core/approvals/index.ts';
import {
  evaluatePolicyWithAudit,
  POLICY_ACTION_CATALOG,
  type PolicyActor,
} from '../core/policy/index.ts';
import {
  redactSensitiveText,
  redactSensitiveValue,
} from '../execution/secret-redactor.ts';
import {
  DEPARTMENT_AGENT_DEFINITIONS,
  getDepartmentAgentDefinition,
} from './agent-definitions.ts';
import type {
  DepartmentAgentDefinition,
  DepartmentAgentDefinition as AgentDefinition,
} from './agent-types.ts';
import { toContractAgent } from './agent-types.ts';
import type {
  AgentApprovalRequest,
  CreateObjectiveInput,
  CreateObjectiveResult,
  DelegationActorContext,
  DelegationEngineOptions,
  DelegationExecutionSummary,
  DelegationProjectRecord,
  DelegationQueueMetrics,
  DelegationRequest,
  DelegationSandboxExecutor,
  DelegationStore,
  DelegationTaskEventRecord,
  DelegationTaskRecord,
  DelegationTaskStatus,
  DepartmentAgentResult,
  ReviewAgentResult,
  WatchdogResult,
} from './delegation-types.ts';
import {
  DELEGATION_TASK_STATUSES,
} from './delegation-types.ts';
import type { ModelWorkerClient } from './model-worker/model-worker-types.ts';

const FORBIDDEN_DELEGATION_INPUT_KEYS = new Set([
  'permission',
  'permissions',
  'grant',
  'grants',
  'role',
  'autonomy',
  'autonomy_level',
  'owner',
  'owner_id',
  'approval',
  'approvals',
  'approval_override',
  'approved',
  'scope',
  'scopes',
  'api_key',
  'apikey',
  'token',
  'password',
  'secret',
  'credentials',
  'private_key',
]);

const SECRET_KEY_PATTERN =
  /(^|[_.-])(password|passphrase|secret|secret_?key|api_?key|access_?token|refresh_?token|bearer_?token|auth_?token|private_?key|client_?secret|credentials?|authorization|cookie|session|mfa|totp|recovery_?codes?|jwt|ssh_?key|master_?key)$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function truncate(value: string, max = 2000): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function findForbiddenKeys(
  value: unknown,
  base = '$',
  depth = 0,
  visited = new Set<object>(),
): string[] {
  if (value === null || typeof value !== 'object') {
    return [];
  }
  if (depth > 12) {
    return [`${base}:max_depth_exceeded`];
  }
  if (visited.has(value)) {
    return [`${base}:circular_reference`];
  }
  visited.add(value);
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...findForbiddenKeys(item, `${base}[${index}]`, depth + 1, visited));
    });
    return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (
      FORBIDDEN_DELEGATION_INPUT_KEYS.has(key.toLowerCase()) ||
      SECRET_KEY_PATTERN.test(key)
    ) {
      found.push(`${base}.${key}`);
    }
    found.push(...findForbiddenKeys(nested, `${base}.${key}`, depth + 1, visited));
  }
  return found;
}

function makeEvent(params: {
  taskId: string;
  eventType: string;
  fromStatus: DelegationTaskStatus | null;
  toStatus: DelegationTaskStatus | null;
  actorId: string;
  message: string;
  metadata?: Record<string, unknown>;
  nowIso: string;
}): DelegationTaskEventRecord {
  return {
    event_id: `evt_${params.taskId}_${crypto.randomUUID()}`,
    task_id: params.taskId,
    event_type: params.eventType,
    from_status: params.fromStatus,
    to_status: params.toStatus,
    actor_id: params.actorId,
    message: params.message,
    metadata: params.metadata ?? {},
    created_at: params.nowIso,
  };
}

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const AGENT_APPROVAL_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  content_social: ['publish:public'],
};

export class DelegationEngine {
  private readonly store: DelegationStore;
  private readonly approvals: DelegationEngineOptions['approvals'];
  private readonly auditLogger: DelegationEngineOptions['auditLogger'];
  private readonly systemConfig: unknown;
  private readonly clock: () => Date;
  private readonly modelWorker: ModelWorkerClient | null;
  private readonly sandboxExecutor: DelegationSandboxExecutor | null;
  private readonly maxConcurrentTasks: number;
  private readonly maxDelegationDepth: number;
  private readonly maxTotalTasksPerProject: number;
  private readonly stuckTaskAfterMs: number;
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(options: DelegationEngineOptions) {
    this.store = options.store;
    this.approvals = options.approvals;
    this.auditLogger = options.auditLogger;
    this.systemConfig = options.systemConfig;
    this.clock = options.clock ?? (() => new Date());
    this.modelWorker = options.modelWorker ?? null;
    this.sandboxExecutor = options.sandboxExecutor ?? null;
    this.maxConcurrentTasks = Math.max(1, Math.min(8, options.maxConcurrentTasks ?? 2));
    this.maxDelegationDepth = Math.max(1, Math.min(4, options.maxDelegationDepth ?? 2));
    this.maxTotalTasksPerProject = Math.max(
      2,
      Math.min(100, options.maxTotalTasksPerProject ?? 40),
    );
    this.stuckTaskAfterMs = Math.max(60_000, options.stuckTaskAfterMs ?? 10 * 60_000);

    this.store.seedDepartmentAgentState(
      DEPARTMENT_AGENT_DEFINITIONS.map((definition) => definition.id),
      this.clock().toISOString(),
    );
  }

  listAgentDefinitions(): readonly DepartmentAgentDefinition[] {
    return DEPARTMENT_AGENT_DEFINITIONS;
  }

  listAgents(): Array<{
    definition: DepartmentAgentDefinition;
    state: ReturnType<DelegationStore['getDepartmentAgentState']>;
  }> {
    return DEPARTMENT_AGENT_DEFINITIONS.map((definition) => ({
      definition,
      state: this.store.getDepartmentAgentState(definition.id),
    }));
  }

  getAgentDefinition(agentId: string): DepartmentAgentDefinition | null {
    return getDepartmentAgentDefinition(agentId);
  }

  getProject(projectId: string): DelegationProjectRecord | null {
    return this.store.getProject(projectId);
  }

  listProjects(limit = 50): DelegationProjectRecord[] {
    return this.store.listProjects(limit);
  }

  listTasks(filter?: Parameters<DelegationStore['listTasks']>[0]): DelegationTaskRecord[] {
    return this.store.listTasks(filter);
  }

  getTask(taskId: string): DelegationTaskRecord | null {
    return this.store.getTask(taskId);
  }

  getTaskDetail(taskId: string): {
    task: DelegationTaskRecord;
    project: DelegationProjectRecord | null;
    events: DelegationTaskEventRecord[];
    children: DelegationTaskRecord[];
  } | null {
    const task = this.store.getTask(taskId);
    if (!task) {
      return null;
    }
    return {
      task,
      project: this.store.getProject(task.project_id),
      events: this.store.listEvents(taskId),
      children: this.store.listChildren(taskId),
    };
  }

  listAlerts(limit = 100) {
    return this.store.listAlerts(limit);
  }

  acknowledgeAlert(alertId: string, actorId: string): boolean {
    return this.store.acknowledgeAlert(alertId, this.clock().toISOString());
  }

  listWorkerHeartbeats() {
    return this.store.listWorkerHeartbeats();
  }

  getQueueMetrics(): DelegationQueueMetrics {
    const counts = this.store.countTasksByStatus();
    const queued = this.store.listTasks({ status: 'QUEUED', limit: 500 });
    const oldest = queued.length
      ? new Date(queued[queued.length - 1]!.created_at).getTime()
      : null;
    const total = DELEGATION_TASK_STATUSES.reduce(
      (sum, status) => sum + counts[status],
      0,
    );
    return {
      counts,
      active:
        counts.ASSIGNED + counts.RUNNING + counts.RETRYING,
      queued: counts.QUEUED,
      waiting_for_approval: counts.WAITING_FOR_APPROVAL,
      oldest_queued_age_ms:
        oldest === null ? null : Math.max(0, this.clock().getTime() - oldest),
      total,
    };
  }

  private definitionOrFail(task: DelegationTaskRecord): DepartmentAgentDefinition {
    const definition = getDepartmentAgentDefinition(task.agent_id);
    if (!definition) {
      throw new Error(`Unknown department agent "${task.agent_id}".`);
    }
    if (definition.department !== task.department) {
      throw new Error(
        `Task department "${task.department}" does not match agent department "${definition.department}".`,
      );
    }
    return definition;
  }

  private toActor(definition: DepartmentAgentDefinition, task: DelegationTaskRecord): PolicyActor {
    return {
      id: definition.id,
      type: 'agent',
      trusted_autonomy_level: definition.permitted_autonomy_level,
      trusted_authenticated: true,
      trusted_agent_record: toContractAgent(definition, task.created_at),
    };
  }

  private authorizeTask(task: DelegationTaskRecord, definition: DepartmentAgentDefinition): {
    allowed: boolean;
    code: string;
    reason: string;
  } {
    const result = evaluatePolicyWithAudit({
      actor: this.toActor(definition, task),
      action: task.action,
      resource: { id: task.resource_id, type: 'delegation_task' },
      environment: task.environment,
      declared_scopes: definition.scopes,
      approval: null,
      system_config: this.systemConfig,
      audit_logger: this.auditLogger,
      correlation_id: task.correlation_id,
      now: this.clock(),
    });
    return {
      allowed: result.allowed,
      code: result.reason_code,
      reason: result.reason,
    };
  }

  private transition(
    task: DelegationTaskRecord,
    status: DelegationTaskStatus,
    actorId: string,
    message: string,
    extra?: {
      output?: Record<string, unknown> | null;
      error?: DelegationTaskRecord['error'];
      approvalId?: string | null;
      approvalRequired?: boolean;
      retryCount?: number;
      childTaskIds?: string[];
      dependencies?: string[];
      startedAt?: string | null;
      finishedAt?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): DelegationTaskRecord | null {
    const nowIso = this.clock().toISOString();
    return this.store.updateTask({
      taskId: task.task_id,
      status,
      output: extra?.output,
      error: extra?.error,
      approvalId: extra?.approvalId,
      approvalRequired: extra?.approvalRequired,
      retryCount: extra?.retryCount,
      childTaskIds: extra?.childTaskIds,
      dependencies: extra?.dependencies,
      startedAt: extra?.startedAt,
      finishedAt: extra?.finishedAt,
      updatedAt: nowIso,
      event: makeEvent({
        taskId: task.task_id,
        eventType: `task.${status.toLowerCase()}`,
        fromStatus: task.status,
        toStatus: status,
        actorId,
        message,
        metadata: extra?.metadata,
        nowIso,
      }),
    });
  }

  createObjective(
    input: CreateObjectiveInput,
    ctx: DelegationActorContext,
  ):
    | { ok: true; data: CreateObjectiveResult }
    | { ok: false; code: string; error: string } {
    if (ctx.actor.type !== 'owner' || ctx.actor.trusted_authenticated !== true) {
      return {
        ok: false,
        code: 'OWNER_AUTHENTICATION_REQUIRED',
        error: 'Only the authenticated human owner may create objectives.',
      };
    }
    if (typeof ctx.correlation_id !== 'string' || ctx.correlation_id.trim().length < 2) {
      return {
        ok: false,
        code: 'INVALID_CORRELATION_ID',
        error: 'A valid correlation ID is required.',
      };
    }
    const name = input.name.trim();
    const objective = input.objective.trim();
    if (name.length < 2 || name.length > 160) {
      return { ok: false, code: 'INVALID_PROJECT_NAME', error: 'Project name must be 2-160 characters.' };
    }
    if (objective.length < 8 || objective.length > 4000) {
      return {
        ok: false,
        code: 'INVALID_OBJECTIVE',
        error: 'Objective must be 8-4000 characters.',
      };
    }
    const projectContext = isPlainObject(input.context) ? input.context : {};
    const forbiddenContext = findForbiddenKeys(projectContext);
    if (forbiddenContext.length > 0) {
      return {
        ok: false,
        code: 'FORBIDDEN_CONTEXT_FIELDS',
        error: `Objective context contains forbidden fields: ${forbiddenContext.slice(0, 5).join(', ')}.`,
      };
    }
    if (input.idempotency_key) {
      const existing = this.store.getTaskByIdempotencyKey(input.idempotency_key);
      if (existing) {
        const project = this.store.getProject(existing.project_id);
        if (project) {
          return { ok: true, data: { project, task: existing, duplicate: true } };
        }
      }
    }

    const nowIso = this.clock().toISOString();
    const projectId = `dproj_${crypto.randomUUID()}`;
    const project: DelegationProjectRecord = {
      project_id: projectId,
      name,
      objective,
      context: projectContext,
      allowed_agent_ids: DEPARTMENT_AGENT_DEFINITIONS.map((definition) => definition.id),
      owner_id: ctx.actor.id,
      created_at: nowIso,
      updated_at: nowIso,
    };
    this.store.createProject(project);

    const ceo = getDepartmentAgentDefinition('ceo_strategy')!;
    const taskId = `dtask_${crypto.randomUUID()}`;
    const task: DelegationTaskRecord = {
      task_id: taskId,
      project_id: projectId,
      parent_task_id: null,
      root_task_id: taskId,
      agent_id: ceo.id,
      department: ceo.department,
      status: 'CREATED',
      action: 'agent:plan',
      resource_id: `project:${projectId}`,
      environment: input.environment ?? 'local',
      title: name,
      description: objective,
      input: {
        project_id: projectId,
        objective,
        deliverable: 'project_plan',
        constraints: [],
        project_context: project.context,
      },
      output: null,
      error: null,
      risk_level: ceo.risk_level,
      approval_id: null,
      approval_required: false,
      depth: 0,
      max_depth: this.maxDelegationDepth,
      retry_count: 0,
      max_retries: ceo.max_retries,
      timeout_ms: ceo.timeout_ms,
      idempotency_key: input.idempotency_key ?? null,
      dependencies: [],
      child_task_ids: [],
      correlation_id: ctx.correlation_id,
      cancellation_requested: false,
      started_at: null,
      finished_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    };

    const created = this.store.createTask({
      task,
      event: makeEvent({
        taskId,
        eventType: 'task.created',
        fromStatus: null,
        toStatus: 'CREATED',
        actorId: ctx.actor.id,
        message: `Objective accepted for project "${name}".`,
        nowIso,
      }),
    });

    this.transition(
      created.task,
      'VALIDATING',
      'system:delegation_engine',
      'Validating objective, owner identity, and delegation policy.',
    );
    const validated = this.store.getTask(taskId)!;
    this.transition(
      validated,
      'QUEUED',
      'system:delegation_engine',
      'Root CEO planning task queued.',
    );

    this.auditLogger.logEvent({
      actor_type: 'owner',
      actor_id: ctx.actor.id,
      event_type: 'delegation.objective.created',
      resource_type: 'task',
      resource_id: projectId,
      action: 'agent:plan',
      outcome: 'success',
      correlation_id: ctx.correlation_id,
      metadata: { task_id: taskId, name },
    });

    return {
      ok: true,
      data: { project, task: this.store.getTask(taskId)!, duplicate: false },
    };
  }

  async processQueue(limit = 10): Promise<DelegationExecutionSummary> {
    const processedTasks: DelegationTaskRecord[] = [];
    let completed = 0;
    let failed = 0;
    let waiting = 0;

    for (let i = 0; i < Math.max(1, Math.min(50, limit)); i += 1) {
      if (this.store.countActiveTasks() >= this.maxConcurrentTasks) {
        break;
      }
      const task = this.store.claimNextQueuedTask(this.clock().toISOString());
      if (!task) {
        break;
      }
      const result = await this.executeTask(task);
      if (result) {
        processedTasks.push(result);
        if (result.status === 'COMPLETED') completed += 1;
        if (result.status === 'FAILED') failed += 1;
        if (result.status === 'WAITING_FOR_APPROVAL') waiting += 1;
      }
    }

    return {
      processed: processedTasks.length,
      completed,
      failed,
      waiting_for_approval: waiting,
      tasks: processedTasks,
    };
  }

  async runTaskById(taskId: string): Promise<DelegationTaskRecord | null> {
    const claimed = this.store.claimTask(taskId, this.clock().toISOString());
    if (!claimed) {
      return null;
    }
    return this.executeTask(claimed);
  }

  private async executeTask(task: DelegationTaskRecord): Promise<DelegationTaskRecord | null> {
    const definition = this.definitionOrFail(task);
    const project = this.store.getProject(task.project_id);
    if (!project) {
      return this.failTask(task, definition, {
        code: 'PROJECT_NOT_FOUND',
        message: `Project "${task.project_id}" was not found.`,
        retryable: false,
      });
    }
    if (!project.allowed_agent_ids.includes(task.agent_id)) {
      return this.failTask(task, definition, {
        code: 'PROJECT_ACCESS_DENIED',
        message: `Agent "${task.agent_id}" is not allowed to access project "${task.project_id}".`,
        retryable: false,
      });
    }
    if (task.cancellation_requested) {
      return this.cancelOne(task, 'system:delegation_engine', 'Task was cancelled before execution.');
    }

    const authz = this.authorizeTask(task, definition);
    if (!authz.allowed) {
      return this.failTask(task, definition, {
        code: authz.code,
        message: authz.reason,
        retryable: false,
      });
    }

    let running = this.transition(
      task,
      'RUNNING',
      'system:delegation_engine',
      `Agent "${definition.name}" started task.`,
      { startedAt: task.started_at ?? this.clock().toISOString() },
    ) ?? task;

    this.store.updateDepartmentAgentState({
      agentId: definition.id,
      health: 'healthy',
      currentTaskId: running.task_id,
      lastHeartbeatAt: this.clock().toISOString(),
      updatedAt: this.clock().toISOString(),
    });

    if (running.approval_required) {
      if (!running.approval_id) {
        const actionDefinition =
          POLICY_ACTION_CATALOG[
            running.action as keyof typeof POLICY_ACTION_CATALOG
          ];
        return this.requestTaskApproval(running, definition, {
          action: running.action,
          resource_id: running.resource_id,
          reason: running.description,
          risk_level: running.risk_level,
          required_scope:
            actionDefinition?.required_scope ?? definition.scopes[0] ?? 'agent:plan',
        });
      }
      const approval = this.approvals.getApproval(running.approval_id);
      if (!approval) {
        return this.failTask(running, definition, {
          code: 'APPROVAL_NOT_FOUND',
          message: 'Required approval record was not found.',
          retryable: false,
        });
      }
      const consumed = this.approvals.verifyAndConsumeApproval({
        approval_id: approval.id,
        task_id: running.task_id,
        action: approval.action,
        resource_id: running.resource_id,
        required_scope: approval.scope.permissions[0] ?? 'agent:plan',
        environment: approval.environment,
        actor_id: definition.id,
        correlation_id: running.correlation_id,
      });
      if (!consumed.ok) {
        return this.failTask(running, definition, {
          code: consumed.code,
          message: consumed.error,
          retryable: false,
        });
      }
      running = this.store.getTask(running.task_id) ?? running;
      running = { ...running, input: { ...running.input, __approval_granted: true } };
    }

    const controller = new AbortController();
    this.activeControllers.set(running.task_id, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Task timed out after ${running.timeout_ms}ms.`));
    }, running.timeout_ms);

    try {
      const inputWithUpstream = this.buildTaskInput(running, project);
      const result = await this.runAgentHandler(
        running,
        definition,
        inputWithUpstream,
        controller.signal,
      );
      if (controller.signal.aborted) {
        if (running.cancellation_requested) {
          return this.cancelOne(running, 'system:delegation_engine', 'Task cancelled during execution.');
        }
        return this.failTask(running, definition, {
          code: timedOut ? 'TASK_TIMEOUT' : 'TASK_ABORTED',
          message: timedOut
            ? `Task exceeded its ${running.timeout_ms}ms timeout.`
            : 'Task execution was aborted.',
          retryable: !timedOut,
        });
      }
      return await this.handleAgentResult(running, definition, project, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Agent handler failed.';
      return this.failTask(running, definition, {
        code: timedOut ? 'TASK_TIMEOUT' : 'AGENT_HANDLER_ERROR',
        message,
        retryable: !timedOut,
      });
    } finally {
      clearTimeout(timer);
      this.activeControllers.delete(running.task_id);
      this.store.updateDepartmentAgentState({
        agentId: definition.id,
        currentTaskId: null,
        health: 'healthy',
        lastHeartbeatAt: this.clock().toISOString(),
        updatedAt: this.clock().toISOString(),
      });
    }
  }

  private getKnownSecrets(): string[] {
    const values: string[] = [];
    for (const name of [
      'TEJAURA_SECRETS_MASTER_KEY',
      'TEJAURA_AIRLLM_WORKER_TOKEN',
    ]) {
      const value = process.env[name];
      if (typeof value === 'string' && value.trim().length >= 8) {
        values.push(value.trim());
      }
    }
    return values;
  }

  private redact<T>(value: T): T {
    return redactSensitiveValue(value, this.getKnownSecrets()).value as T;
  }

  private buildTaskInput(
    task: DelegationTaskRecord,
    project: DelegationProjectRecord,
  ): Record<string, unknown> {
    const upstream = task.dependencies
      .map((depId) => this.store.getTask(depId))
      .filter((dep): dep is DelegationTaskRecord => dep !== null)
      .map((dep) => ({
        task_id: dep.task_id,
        agent_id: dep.agent_id,
        title: dep.title,
        status: dep.status,
        output: dep.output,
      }));
    return this.redact({
      ...task.input,
      project_id: task.project_id,
      project_context: project.context,
      upstream_outputs: upstream,
      constraints: asStringArray(task.input.constraints),
      objective: asString(task.input.objective, project.objective),
    });
  }

  private async runAgentHandler(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<DepartmentAgentResult | ReviewAgentResult | WatchdogResult> {
    if (signal.aborted) {
      throw new Error('Task aborted before handler execution.');
    }
    switch (task.action) {
      case 'agent:plan':
      case 'agent:delegate':
        if (asString(input.mode) === 'consolidate') {
          return this.consolidateProject(task, definition, input);
        }
        return this.planObjective(task, definition, input);
      case 'agent:write_code':
      case 'agent:test':
        return this.runEngineering(task, definition, input, signal);
      case 'agent:design':
        return this.runDesign(task, definition, input);
      case 'agent:seo_analyze':
        return this.runSeo(task, definition, input);
      case 'agent:draft_content':
        return this.runContent(task, definition, input);
      case 'agent:support_draft':
        return this.runSupport(task, definition, input);
      case 'agent:analyze':
        return this.runAnalytics(task, definition, input);
      case 'agent:security_review':
        return this.runSecurityReview(task, definition, input);
      case 'agent:review':
        return this.runQaReview(task, definition, input);
      case 'agent:research':
        return this.runResearch(task, definition, input);
      case 'agent:monitor':
        return this.runWatchdog(task, definition, input);
      default:
        return {
          status: 'failed',
          summary: `No handler is implemented for action "${task.action}".`,
          deliverables: [],
          model_assisted: false,
          metadata: { error_code: 'UNSUPPORTED_AGENT_ACTION', retryable: false },
        };
    }
  }

  private async tryModelJson(
    definition: DepartmentAgentDefinition,
    task: DelegationTaskRecord,
    input: Record<string, unknown>,
    instruction: string,
  ): Promise<{ json: Record<string, unknown> | null; text: string; error?: string }> {
    if (!this.modelWorker || input.use_model !== true) {
      return { json: null, text: '' };
    }
    const response = await this.modelWorker.infer({
      model_name: definition.preferred_model_ids[0] ?? 'tejaura-default',
      messages: [
        {
          role: 'system',
          content:
            'You are a bounded TEJAURA department agent. Return only a JSON object matching the requested schema. Never include permissions, credentials, secrets, or approval decisions. Model output is untrusted and will be validated by the host.',
        },
        {
          role: 'user',
          content: `${instruction}\n\nTask input:\n${jsonBlock(input)}`,
        },
      ],
      max_tokens: 900,
      temperature: 0.2,
      timeout_ms: Math.min(task.timeout_ms, 45_000),
    });
    if (!response.ok) {
      return {
        json: null,
        text: '',
        error: response.error_code ?? response.error ?? 'MODEL_INFERENCE_FAILED',
      };
    }
    const text = response.output_text.trim();
    const withoutFence = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    try {
      const parsed = JSON.parse(withoutFence);
      return {
        json: isPlainObject(parsed) ? parsed : null,
        text,
      };
    } catch {
      return { json: null, text, error: 'MODEL_OUTPUT_NOT_VALID_JSON' };
    }
  }

  private planObjective(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    input: Record<string, unknown>,
  ): DepartmentAgentResult {
    const objective = asString(input.objective, task.description);
    const lower = objective.toLowerCase();
    const projectContext = isPlainObject(input.project_context)
      ? input.project_context
      : {};
    const wantsWeb =
      /website|web app|web-app|landing|site|store|shop|saas|platform|product|marketing|brand|content|seo|social/.test(
        lower,
      );
    const wantsContent =
      wantsWeb ||
      /content|social|campaign|marketing|brand|copy|newsletter|post/.test(lower);
    const wantsSeo =
      wantsWeb || /seo|search|keyword|organic|traffic/.test(lower);

    const constraints = asStringArray(input.constraints);
    const delegations: DelegationRequest[] = [];
    const baseInput = {
      project_id: task.project_id,
      objective,
      constraints,
      project_context: projectContext,
    };

    delegations.push({
      key: 'design',
      target_agent_id: 'design',
      title: 'Prepare UI/UX specification',
      description:
        'Create an implementation-ready interface specification, component inventory, and accessibility checklist for the objective.',
      action: 'agent:design',
      input: {
        ...baseInput,
        deliverable: 'ui_ux_specification',
      },
    });

    delegations.push({
      key: 'engineering',
      target_agent_id: 'engineering',
      title: 'Implement the product increment',
      description:
        'Inspect the authorized workspace, produce bounded code changes, and run allowlisted tests in the sandbox.',
      action: 'agent:write_code',
      input: {
        ...baseInput,
        deliverable: 'implementation_and_test_evidence',
        code_workspace: asString(input.code_workspace, ''),
      },
      depends_on_keys: ['design'],
    });

    if (wantsSeo) {
      delegations.push({
        key: 'seo',
        target_agent_id: 'seo',
        title: 'Prepare SEO requirements',
        description:
          'Analyze the site concept and produce keyword clusters, metadata requirements, and content briefs.',
        action: 'agent:seo_analyze',
        input: {
          ...baseInput,
          deliverable: 'seo_strategy',
        },
      });
    }

    if (wantsContent) {
      delegations.push({
        key: 'content',
        target_agent_id: 'content_social',
        title: 'Prepare draft content package',
        description:
          'Draft launch copy and platform-ready content. Do not publish; any public release requires owner approval.',
        action: 'agent:draft_content',
        input: {
          ...baseInput,
          deliverable: 'draft_content_package',
          requested_publish: /publish|launch|announce|public/.test(lower),
        },
        depends_on_keys: wantsSeo ? ['seo'] : [],
      });
    }

    const wantsResearch =
      /research|market|competitor|discovery|survey|interview|trend|landscape/.test(lower);
    if (wantsResearch) {
      delegations.push({
        key: 'research',
        target_agent_id: 'research',
        title: 'Synthesize supplied research evidence',
        description:
          'Review only owner- or upstream-supplied sources, produce a bounded brief, and state evidence gaps without inventing facts.',
        action: 'agent:research',
        input: {
          ...baseInput,
          deliverable: 'research_brief',
          research_question: objective,
        },
      });
    }

    delegations.push({
      key: 'analytics',
      target_agent_id: 'analytics',
      title: 'Define success metrics and baseline report',
      description:
        'Define measurable success metrics and produce a baseline operational report from supplied data.',
      action: 'agent:analyze',
      input: {
        ...baseInput,
        deliverable: 'analytics_baseline',
        metrics: isPlainObject(input.metrics) ? input.metrics : {},
      },
    });

    delegations.push({
      key: 'security',
      target_agent_id: 'security',
      title: 'Perform security review',
      description:
        'Review the design and implementation outputs for security risks and secret exposure. Recommend fixes without changing controls.',
      action: 'agent:security_review',
      input: {
        ...baseInput,
        deliverable: 'security_review',
      },
      depends_on_keys: ['engineering'],
    });

    const qaDependencies = ['design', 'engineering'];
    if (wantsSeo) qaDependencies.push('seo');
    if (wantsContent) qaDependencies.push('content');
    if (wantsResearch) qaDependencies.push('research');
    qaDependencies.push('analytics', 'security');
    delegations.push({
      key: 'qa',
      target_agent_id: 'qa_reviewer',
      title: 'Independently review deliverables',
      description:
        'Validate acceptance criteria, test evidence, and completion claims. Reject unsupported or incomplete work.',
      action: 'agent:review',
      input: {
        ...baseInput,
        deliverable: 'qa_review',
        acceptance_criteria: [
          'Design specification is implementation-ready.',
          'Engineering changes report changed files and executed tests.',
          'Security review has no unresolved critical findings.',
          'Content and SEO outputs are drafts only and are not published.',
        ],
      },
      depends_on_keys: qaDependencies,
    });

    const plan = {
      objective,
      constraints,
      delegation_keys: delegations.map((item) => item.key),
      model_assisted: false,
      note: 'Deterministic host-side plan. Optional local model output may add narrative but cannot alter permissions or delegation targets.',
    };

    return {
      status: 'completed',
      summary: `CEO decomposed the objective into ${delegations.length} bounded department tasks.`,
      deliverables: [
        {
          name: 'Project plan',
          kind: 'plan',
          content: jsonBlock(plan),
        },
      ],
      delegations,
      model_assisted: false,
      metadata: { planning_mode: 'deterministic', department: definition.department },
    };
  }

  private consolidateProject(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    input: Record<string, unknown>,
  ): DepartmentAgentResult {
    const children = this.store
      .listChildren(task.parent_task_id ?? task.task_id)
      .filter((child) => child.task_id !== task.task_id);
    const report = children.map((child) => ({
      task_id: child.task_id,
      agent_id: child.agent_id,
      title: child.title,
      status: child.status,
      summary:
        child.output && typeof child.output.summary === 'string'
          ? child.output.summary
          : null,
      deliverables:
        child.output && Array.isArray(child.output.deliverables)
          ? child.output.deliverables
          : [],
    }));
    const failed = children.filter((child) => child.status === 'FAILED');
    const blocked = children.filter((child) => child.status === 'CANCELLED');
    const completed = children.filter((child) => child.status === 'COMPLETED');
    const verdict =
      failed.length > 0 || blocked.length > 0
        ? 'completed_with_failures'
        : 'completed';
    return {
      status: 'completed',
      summary:
        failed.length > 0 || blocked.length > 0
          ? `CEO consolidated the project with ${failed.length} failed and ${blocked.length} cancelled department task(s).`
          : `CEO consolidated ${completed.length} completed department task(s) into the final report.`,
      deliverables: [
        {
          name: 'Consolidated project report',
          kind: 'report',
          content: jsonBlock({
            objective: asString(input.objective, task.description),
            verdict,
            completed: completed.length,
            failed: failed.length,
            cancelled: blocked.length,
            departments: report,
            owner_action_required:
              failed.length > 0 || blocked.length > 0
                ? 'Review failed or cancelled department tasks before accepting the result.'
                : 'Review the report and any pending approval requests.',
          }),
        },
      ],
      model_assisted: false,
      metadata: {
        department: definition.department,
        consolidation: true,
        verdict,
      },
    };
  }

  private async runEngineering(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<DepartmentAgentResult> {
    if (!this.sandboxExecutor) {
      return {
        status: 'blocked',
        summary:
          'Engineering execution requires an isolated sandbox executor. No executor is configured.',
        deliverables: [],
        model_assisted: false,
        metadata: {
          error_code: 'SANDBOX_EXECUTOR_NOT_CONFIGURED',
          retryable: false,
        },
      };
    }
    const projectContext = isPlainObject(input.project_context)
      ? input.project_context
      : {};
    const contextFiles = Array.isArray(projectContext.files)
      ? projectContext.files
      : [];
    const files = Array.isArray(input.files) ? input.files : contextFiles;
    const testCommand =
      typeof input.test_command === 'string'
        ? input.test_command
        : typeof projectContext.test_command === 'string'
          ? projectContext.test_command
          : 'node --test';
    const result = await this.sandboxExecutor.runEngineeringTask({
      task,
      agentId: definition.id,
      input: {
        ...input,
        files: files.map((file) => (isPlainObject(file) ? { ...file } : file)),
        test_command: testCommand,
      },
      signal,
    });
    if (!result.ok) {
      return {
        status: 'failed',
        summary: result.error?.message ?? 'Sandbox engineering execution failed.',
        deliverables: [],
        model_assisted: false,
        metadata: {
          error_code: result.error?.code ?? 'SANDBOX_EXECUTION_FAILED',
          retryable: result.error?.retryable ?? true,
        },
      };
    }
    return {
      status: 'completed',
      summary: 'Engineering task executed inside the configured sandbox.',
      deliverables: [
        {
          name: 'Engineering result',
          kind: 'code',
          content: jsonBlock(result.result ?? {}),
        },
      ],
      model_assisted: false,
      test_evidence:
        isPlainObject(result.result?.test_evidence)
          ? (result.result.test_evidence as Record<string, unknown>)
          : undefined,
      metadata: {
        department: definition.department,
        sandbox_result: result.result ?? {},
      },
    };
  }

  private runDesign(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    input: Record<string, unknown>,
  ): DepartmentAgentResult {
    const objective = asString(input.objective, task.description);
    const spec = {
      objective,
      design_principles: [
        'Dark, premium, minimal interface with strong hierarchy.',
        'Mobile-first responsive layout with touch targets at least 44px.',
        'Use #030712 background, #6366F1 primary, #06B6D4 accent.',
        'Accessible contrast, visible focus states, and semantic structure.',
      ],
      deliverables: [
        'Screen and component inventory',
        'Layout and spacing specification',
        'Interaction and empty/loading/error states',
        'Accessibility checklist',
      ],
      handoff_notes:
        'Implementation should consume design tokens and avoid decorative clutter.',
    };
    return {
      status: 'completed',
      summary: 'Design Agent produced an implementation-ready UI/UX specification.',
      deliverables: [
        {
          name: 'UI/UX specification',
          kind: 'specification',
          content: jsonBlock(spec),
        },
      ],
      model_assisted: false,
      metadata: { department: definition.department },
    };
  }

  private runSeo(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    input: Record<string, unknown>,
  ): DepartmentAgentResult {
    const objective = asString(input.objective, task.description);
    const words = objective
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3)
      .slice(0, 12);
    const clusters = [
      {
        intent: 'commercial',
        keywords: words.slice(0, 4).map((word) => `${word} solution`),
      },
      {
        intent: 'informational',
        keywords: words.slice(4, 8).map((word) => `how to ${word}`),
      },
      {
        intent: 'comparison',
        keywords: words.slice(8, 12).map((word) => `best ${word}`),
      },
    ];
    const strategy = {
      objective,
      keyword_clusters: clusters,
      metadata_requirements: [
        'Unique title tag and meta description per page',
        'Canonical URLs',
        'Open Graph and social preview metadata',
        'Structured data where appropriate',
      ],
      content_briefs: [
        'Publish a clear product landing page with proof and FAQ sections.',
        'Create one comparison article and one educational guide.',
      ],
      risks: [
        'No publishing without owner approval.',
        'Do not claim search rankings or traffic outcomes without measured data.',
      ],
    };
    return {
      status: 'completed',
      summary: 'SEO Agent prepared keyword clusters, metadata requirements, and content briefs.',
      deliverables: [
        {
          name: 'SEO strategy',
          kind: 'recommendation',
          content: jsonBlock(strategy),
        },
      ],
      model_assisted: false,
      metadata: { department: definition.department },
    };
  }

  private runContent(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    input: Record<string, unknown>,
  ): DepartmentAgentResult {
    const objective = asString(input.objective, task.description);
    const approved = input.__approval_granted === true;
    const publishRequested = input.requested_publish === true;
    const packageContent = {
      objective,
      drafts: [
        {
          channel: 'website',
          headline: `Introducing ${objective.slice(0, 80)}`,
          body: 'Draft launch copy prepared for owner review. Claims must be verified before publication.',
        },
        {
          channel: 'social',
          body: 'Short-form announcement draft. Owner approval is required before any public post.',
        },
      ],
      publication_status: approved
        ? 'approved_for_manual_publish'
        : publishRequested
          ? 'approval_required'
          : 'draft_only',
      external_publish_executed: false,
      note:
        'TEJAURA has no external publishing adapter. Approval authorizes the package for manual release; it does not auto-publish.',
    };
    if (publishRequested && !approved) {
      return {
        status: 'needs_approval',
        summary:
          'Content Agent prepared a publication package and requested owner approval before any public release.',
        deliverables: [
          {
            name: 'Draft content package',
            kind: 'copy',
            content: jsonBlock(packageContent),
          },
        ],
        approval_request: {
          action: 'publish:public',
          resource_id: `project:${task.project_id}`,
          reason: `Owner approval required to release content for objective: ${truncate(objective, 240)}`,
          risk_level: 'high',
          required_scope: 'publish:public',
          environment: 'production',
        },
        model_assisted: false,
        metadata: { department: definition.department, publish_requested: true },
      };
    }
    return {
      status: 'completed',
      summary: approved
        ? 'Content Agent prepared an owner-approved publication package. No external publish was executed.'
        : 'Content Agent prepared draft content. No publishing occurred.',
      deliverables: [
        {
          name: 'Draft content package',
          kind: 'copy',
          content: jsonBlock(packageContent),
        },
      ],
      model_assisted: false,
      metadata: { department: definition.department, publish_requested: publishRequested },
    };
  }

  private runSupport(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    input: Record<string, unknown>,
  ): DepartmentAgentResult {
    const query = asString(input.customer_query, asString(input.objective, task.description));
    const sensitive =
      /refund|chargeback|legal|lawsuit|password|account access|privacy|gdpr|medical|minor|abuse/i.test(
        query,
      );
    const response = {
      triage: sensitive ? 'escalate_to_owner' : 'standard_response',
      customer_query: truncate(query, 1000),
      draft_response: sensitive
        ? 'This case requires human review before a response is sent. Do not disclose account or personal data.'
        : 'Thank you for contacting us. We have received your request and will follow up with the next steps.',
      privacy_controls: [
        'No full account identifiers included in the draft.',
        'No external message was sent.',
        'Sensitive cases are escalated instead of answered automatically.',
      ],
    };
    return {
      status: 'completed',
      summary: sensitive
        ? 'Support Agent flagged a sensitive case for owner escalation.'
        : 'Support Agent drafted a response without sending it externally.',
      deliverables: [
        {
          name: 'Support triage and draft',
          kind: 'copy',
          content: jsonBlock(response),
        },
      ],
      model_assisted: false,
      metadata: { department: definition.department, escalated: sensitive },
    };
  }

  private runAnalytics(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    input: Record<string, unknown>,
  ): DepartmentAgentResult {
    const metrics = isPlainObject(input.metrics) ? input.metrics : {};
    const numeric = Object.entries(metrics)
      .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
      .map(([key, value]) => ({ key, value: value as number }));
    const anomalies = numeric.filter((item) => item.value < 0);
    const report = {
      objective: asString(input.objective, task.description),
      metrics_received: numeric,
      anomalies,
      opportunities: [
        'Instrument conversion events before optimizing campaigns.',
        'Define one primary success metric per project.',
        'Review failing tasks and worker availability before scaling concurrency.',
      ],
      limitations:
        'No external analytics API was called. Report is based only on supplied metrics.',
    };
    return {
      status: 'completed',
      summary: `Analytics Agent analyzed ${numeric.length} supplied metric(s) and produced a baseline report.`,
      deliverables: [
        {
          name: 'Analytics baseline report',
          kind: 'report',
          content: jsonBlock(report),
        },
      ],
      model_assisted: false,
      metadata: { department: definition.department, anomaly_count: anomalies.length },
    };
  }

  private runSecurityReview(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    input: Record<string, unknown>,
  ): ReviewAgentResult {
    const upstream = Array.isArray(input.upstream_outputs) ? input.upstream_outputs : [];
    const text = JSON.stringify(upstream) + JSON.stringify(input);
    const findings: ReviewAgentResult['findings'] = [];
    const checks: Array<{ pattern: RegExp; code: string; message: string; severity: ReviewAgentResult['findings'][number]['severity'] }> = [
      {
        pattern: /child_process|exec\(|spawn\(/i,
        code: 'ARBITRARY_PROCESS_EXECUTION',
        message: 'Output references process execution. Verify it is sandboxed and allowlisted.',
        severity: 'high',
      },
      {
        pattern: /eval\(|new Function\(/i,
        code: 'DYNAMIC_CODE_EXECUTION',
        message: 'Output references dynamic code evaluation.',
        severity: 'high',
      },
      {
        pattern: /api[_-]?key|password|secret|bearer\s+[a-z0-9._-]{8,}/i,
        code: 'POSSIBLE_SECRET_EXPOSURE',
        message: 'Output may contain secret-like material. Redact before persistence.',
        severity: 'critical',
      },
      {
        pattern: /chmod\s+777|--privileged|0\.0\.0\.0|no-new-privileges/i,
        code: 'UNSAFE_CONTAINER_CONFIGURATION',
        message: 'Output references a potentially unsafe container or host configuration.',
        severity: 'high',
      },
      {
        pattern: /http:\/\//i,
        code: 'PLAINTEXT_HTTP',
        message: 'Output references plaintext HTTP. Use HTTPS for external endpoints.',
        severity: 'medium',
      },
    ];
    for (const check of checks) {
      if (check.pattern.test(text)) {
        findings.push({
          severity: check.severity,
          code: check.code,
          message: check.message,
          recommendation: 'Review the referenced output and remediate before release.',
        });
      }
    }
    const verdict =
      findings.some((finding) => finding.severity === 'critical')
        ? 'fail'
        : findings.length > 0
          ? 'pass_with_findings'
          : 'pass';
    return {
      status: 'completed',
      summary:
        findings.length === 0
          ? 'Security Agent found no high-confidence issues in the supplied outputs.'
          : `Security Agent found ${findings.length} issue(s) requiring review.`,
      verdict,
      findings,
      model_assisted: false,
      metadata: { department: definition.department, mode: 'deterministic' },
    };
  }

  private runQaReview(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    input: Record<string, unknown>,
  ): ReviewAgentResult {
    const upstream = Array.isArray(input.upstream_outputs)
      ? (input.upstream_outputs as Array<Record<string, unknown>>)
      : [];
    const findings: ReviewAgentResult['findings'] = [];
    const criteria: NonNullable<ReviewAgentResult['acceptance_criteria']> = [];
    const requestedCriteria = asStringArray(input.acceptance_criteria);

    const engineering = upstream.find((item) => item.agent_id === 'engineering');
    const engineeringOutput = isPlainObject(engineering?.output)
      ? engineering.output
      : {};
    const testEvidence = isPlainObject(engineeringOutput.test_evidence)
      ? engineeringOutput.test_evidence
      : null;
    const testsExecuted = testEvidence?.executed === true;

    for (const criterion of requestedCriteria) {
      const met =
        criterion.toLowerCase().includes('test')
          ? testsExecuted
          : upstream.length > 0;
      criteria.push({
        criterion,
        met,
        evidence: met
          ? 'Derived from completed upstream task outputs.'
          : 'No supporting evidence was present in upstream outputs.',
      });
      if (!met) {
        findings.push({
          severity: 'high',
          code: 'ACCEPTANCE_CRITERION_UNMET',
          message: `Acceptance criterion was not supported by evidence: ${criterion}`,
          recommendation: 'Re-run the relevant department task with verifiable evidence.',
        });
      }
    }

    if (engineering && !testsExecuted) {
      findings.push({
        severity: 'high',
        code: 'MISSING_TEST_EVIDENCE',
        message:
          'Engineering output did not include executed test evidence. Completion cannot be accepted.',
        recommendation: 'Run allowlisted tests in the sandbox and attach real output.',
      });
    }
    if (upstream.length === 0) {
      findings.push({
        severity: 'medium',
        code: 'NO_UPSTREAM_OUTPUTS',
        message: 'QA review received no upstream department outputs.',
        recommendation: 'Verify dependency wiring before accepting the project.',
      });
    }

    const verdict = findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical')
      ? 'fail'
      : findings.length > 0
        ? 'pass_with_findings'
        : 'pass';
    return {
      status: 'completed',
      summary:
        verdict === 'fail'
          ? 'QA Agent rejected the completion claim because required evidence is missing.'
          : 'QA Agent validated the supplied outputs and acceptance criteria.',
      verdict,
      findings,
      acceptance_criteria: criteria,
      model_assisted: false,
      metadata: { department: definition.department, reviewed_tasks: upstream.length },
    };
  }

  private runResearch(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    input: Record<string, unknown>,
  ): DepartmentAgentResult {
    const question = asString(
      input.research_question,
      asString(input.objective, task.description),
    );
    const projectContext = isPlainObject(input.project_context)
      ? input.project_context
      : {};
    const rawSources = Array.isArray(input.sources)
      ? input.sources
      : Array.isArray(projectContext.sources)
        ? projectContext.sources
        : [];
    const sources = rawSources
      .slice(0, 20)
      .map((source, index) => {
        if (typeof source === 'string') {
          return {
            source_id: `source_${index + 1}`,
            title: truncate(source, 200),
            notes: '',
          };
        }
        if (!isPlainObject(source)) return null;
        const title = asString(source.title, asString(source.url, `Source ${index + 1}`));
        const notes = asString(
          source.notes,
          asString(source.summary, asString(source.excerpt, '')),
        );
        return {
          source_id: asString(source.id, `source_${index + 1}`),
          title: truncate(title, 200),
          notes: truncate(notes, 1_000),
        };
      })
      .filter((source): source is { source_id: string; title: string; notes: string } => source !== null);

    const findings = sources.map((source) => ({
      source_id: source.source_id,
      title: source.title,
      observation: source.notes
        ? truncate(source.notes, 500)
        : 'No extract was supplied; the source is listed but not interpreted.',
    }));
    const gaps =
      sources.length === 0
        ? [
            'No sources were supplied. The research question remains unanswered.',
            'Owner must provide source documents or approve a bounded external collection task.',
          ]
        : [
            'Findings are limited to the supplied extracts and were not independently verified.',
            'Any decision based on this brief requires owner review of the original sources.',
          ];
    const brief = {
      research_question: question,
      evidence_mode: 'supplied_sources_only',
      external_collection_executed: false,
      source_count: sources.length,
      findings,
      gaps,
      confidence: sources.length === 0 ? 'none' : sources.length < 3 ? 'low' : 'moderate',
      owner_action_required:
        sources.length === 0
          ? 'Provide source evidence or explicitly approve a bounded collection workflow.'
          : 'Review cited sources before using findings in an external decision.',
    };
    return {
      status: 'completed',
      summary:
        sources.length === 0
          ? 'Research Agent recorded an evidence gap: no sources were supplied.'
          : `Research Agent synthesized ${sources.length} supplied source(s) into a bounded brief.`,
      deliverables: [
        {
          name: 'Research brief',
          kind: 'report',
          content: jsonBlock(brief),
        },
      ],
      model_assisted: false,
      metadata: {
        department: definition.department,
        evidence_mode: 'supplied_sources_only',
        source_count: sources.length,
      },
    };
  }

  private runWatchdog(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    input: Record<string, unknown>,
  ): WatchdogResult {
    const alerts = this.watchdogScan();
    return {
      status: 'completed',
      summary: `System watchdog scanned task and worker health and raised ${alerts.length} alert(s).`,
      alerts: alerts.map((alert) => ({
        severity: alert.severity,
        code: alert.code,
        message: alert.message,
        task_id: alert.task_id ?? undefined,
        agent_id: alert.agent_id ?? undefined,
        worker_id: alert.worker_id ?? undefined,
      })),
      model_assisted: false,
      metadata: { department: definition.department },
    };
  }

  private async handleAgentResult(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    project: DelegationProjectRecord,
    result: DepartmentAgentResult | ReviewAgentResult | WatchdogResult,
  ): Promise<DelegationTaskRecord | null> {
    const payload = result as unknown as Record<string, unknown>;
    if (!['completed', 'needs_approval', 'blocked', 'failed'].includes(String(payload.status))) {
      return this.failTask(task, definition, {
        code: 'INVALID_AGENT_RESULT',
        message: 'Agent returned an invalid result status.',
        retryable: false,
      });
    }
    const summary = asString(payload.summary);
    if (summary.length < 1 || summary.length > 4000) {
      return this.failTask(task, definition, {
        code: 'INVALID_AGENT_SUMMARY',
        message: 'Agent result summary must be 1-4000 characters.',
        retryable: false,
      });
    }
    const deliverables = Array.isArray(payload.deliverables) ? payload.deliverables : [];
    if (deliverables.length > 50) {
      return this.failTask(task, definition, {
        code: 'TOO_MANY_DELIVERABLES',
        message: 'Agent returned more than 50 deliverables.',
        retryable: false,
      });
    }
    for (const item of deliverables) {
      if (!isPlainObject(item) || typeof item.name !== 'string' || typeof item.content !== 'string') {
        return this.failTask(task, definition, {
          code: 'INVALID_DELIVERABLE',
          message: 'Each deliverable requires string name and content fields.',
          retryable: false,
        });
      }
      if (item.content.length > 200_000) {
        return this.failTask(task, definition, {
          code: 'DELIVERABLE_TOO_LARGE',
          message: 'Deliverable content exceeds the 200KB limit.',
          retryable: false,
        });
      }
    }

    const redactedResult = this.redact(result);
    const redactedPayload = redactedResult as unknown as Record<string, unknown>;
    const status = String(redactedPayload.status);

    if (status === 'failed') {
      const metadata = isPlainObject(redactedPayload.metadata)
        ? redactedPayload.metadata
        : {};
      return this.failTask(task, definition, {
        code: asString(metadata.error_code, 'AGENT_REPORTED_FAILURE'),
        message: asString(redactedPayload.summary, 'Agent reported failure.'),
        retryable: metadata.retryable !== false,
      });
    }
    if (status === 'blocked') {
      const metadata = isPlainObject(redactedPayload.metadata)
        ? redactedPayload.metadata
        : {};
      return this.failTask(task, definition, {
        code: asString(metadata.error_code, 'AGENT_BLOCKED'),
        message: asString(redactedPayload.summary, 'Agent is blocked.'),
        retryable: false,
      });
    }
    if (status === 'needs_approval' || isPlainObject(redactedPayload.approval_request)) {
      const request = isPlainObject(redactedPayload.approval_request)
        ? redactedPayload.approval_request
        : null;
      if (!request) {
        return this.failTask(task, definition, {
          code: 'MISSING_APPROVAL_REQUEST',
          message: 'Agent requested approval without an approval_request payload.',
          retryable: false,
        });
      }
      return this.requestTaskApproval(task, definition, {
        action: asString(request.action),
        resource_id: asString(request.resource_id, task.resource_id),
        reason: asString(request.reason, task.description),
        risk_level: (['low', 'medium', 'high', 'critical'] as const).includes(
          request.risk_level as 'low' | 'medium' | 'high' | 'critical',
        )
          ? (request.risk_level as 'low' | 'medium' | 'high' | 'critical')
          : 'high',
        required_scope: asString(request.required_scope, 'agent:plan'),
        environment: (['sandbox', 'local', 'staging', 'production'] as const).includes(
          request.environment as ExecutionEnvironment,
        )
          ? (request.environment as ExecutionEnvironment)
          : task.environment,
      });
    }

    const delegations = Array.isArray(redactedPayload.delegations)
      ? redactedPayload.delegations
      : [];
    if (delegations.length > 0) {
      const created = this.createDelegations(task, definition, project, delegations);
      if (!created.ok) {
        return this.failTask(task, definition, {
          code: created.code,
          message: created.error,
          retryable: false,
        });
      }
      return this.completeTask(task, definition, {
        ...redactedPayload,
        delegations_created: true,
        child_task_ids: created.tasks.map((child) => child.task_id),
      });
    }
    return this.completeTask(task, definition, redactedPayload);
  }

  private requestTaskApproval(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    request: AgentApprovalRequest,
  ): DelegationTaskRecord | null {
    if (task.approval_id) {
      return task;
    }
    if (!request.action || !request.resource_id || !request.required_scope) {
      return this.failTask(task, definition, {
        code: 'INVALID_APPROVAL_REQUEST',
        message: 'Approval request is missing action, resource, or required scope.',
        retryable: false,
      });
    }
    const permittedActions = new Set([
      ...definition.allowed_actions,
      ...(AGENT_APPROVAL_ACTIONS[definition.id] ?? []),
    ]);
    if (!permittedActions.has(request.action)) {
      return this.failTask(task, definition, {
        code: 'APPROVAL_ACTION_NOT_PERMITTED',
        message: `Agent "${definition.id}" may not request approval for action "${request.action}".`,
        retryable: false,
      });
    }
    const actionDefinition =
      POLICY_ACTION_CATALOG[request.action as keyof typeof POLICY_ACTION_CATALOG];
    if (!actionDefinition) {
      return this.failTask(task, definition, {
        code: 'UNKNOWN_APPROVAL_ACTION',
        message: `Approval action "${request.action}" is not in the policy catalog.`,
        retryable: false,
      });
    }
    const requestedEnvironment = request.environment ?? task.environment;
    if (!actionDefinition.allowed_environments.includes(requestedEnvironment)) {
      return this.failTask(task, definition, {
        code: 'APPROVAL_ENVIRONMENT_NOT_ALLOWED',
        message: `Action "${request.action}" is not allowed in environment "${requestedEnvironment}".`,
        retryable: false,
      });
    }
    if (actionDefinition.required_scope !== request.required_scope) {
      return this.failTask(task, definition, {
        code: 'APPROVAL_SCOPE_MISMATCH',
        message: `Action "${request.action}" requires scope "${actionDefinition.required_scope}", not "${request.required_scope}".`,
        retryable: false,
      });
    }
    const now = this.clock();
    const result = this.approvals.requestApproval({
      task_id: task.task_id,
      action: request.action,
      requested_by: definition.id,
      environment: request.environment ?? task.environment,
      reason: request.reason,
      scope: {
        resources: [request.resource_id],
        permissions: [request.required_scope],
        single_use: true,
        expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      },
      correlation_id: task.correlation_id,
    });
    if (!result.ok) {
      return this.failTask(task, definition, {
        code: result.code,
        message: result.error,
        retryable: false,
      });
    }
    const updated = this.transition(
      task,
      'WAITING_FOR_APPROVAL',
      definition.id,
      `Agent "${definition.id}" requested owner approval for ${request.action}.`,
      {
        approvalId: result.record.id,
        approvalRequired: true,
        metadata: {
          approval_id: result.record.id,
          requested_action: request.action,
          risk_level: request.risk_level,
        },
      },
    );
    this.auditLogger.logApprovalRequest({
      actor_id: definition.id,
      approval_id: result.record.id,
      task_id: task.task_id,
      action: request.action,
      outcome: 'pending',
      correlation_id: task.correlation_id,
      metadata: { risk_level: request.risk_level },
    });
    return updated;
  }

  private createDelegations(
    parent: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    project: DelegationProjectRecord,
    rawDelegations: unknown[],
  ):
    | { ok: true; tasks: DelegationTaskRecord[] }
    | { ok: false; code: string; error: string } {
    if (definition.max_children <= 0 || definition.allowed_delegate_ids.length === 0) {
      return {
        ok: false,
        code: 'DELEGATION_NOT_PERMITTED',
        error: `Agent "${definition.id}" is not permitted to delegate work.`,
      };
    }
    if (rawDelegations.length > definition.max_children) {
      return {
        ok: false,
        code: 'MAX_CHILDREN_EXCEEDED',
        error: `Agent "${definition.id}" may create at most ${definition.max_children} child tasks.`,
      };
    }
    if (this.store.countProjectTasks(parent.project_id) + rawDelegations.length > this.maxTotalTasksPerProject) {
      return {
        ok: false,
        code: 'PROJECT_TASK_LIMIT_EXCEEDED',
        error: `Project task limit of ${this.maxTotalTasksPerProject} would be exceeded.`,
      };
    }

    const keys = new Set<string>();
    const prepared: Array<{
      key: string;
      target: DepartmentAgentDefinition;
      request: DelegationRequest;
      dependencies: string[];
      taskId: string;
    }> = [];

    for (const raw of rawDelegations) {
      if (!isPlainObject(raw)) {
        return { ok: false, code: 'INVALID_DELEGATION', error: 'Delegation must be an object.' };
      }
      const request = raw as unknown as DelegationRequest;
      const key = asString(request.key).trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(key)) {
        return {
          ok: false,
          code: 'INVALID_DELEGATION_KEY',
          error: `Delegation key "${key}" is invalid.`,
        };
      }
      if (keys.has(key)) {
        return {
          ok: false,
          code: 'DUPLICATE_DELEGATION_KEY',
          error: `Delegation key "${key}" is duplicated.`,
        };
      }
      keys.add(key);
      const target = getDepartmentAgentDefinition(asString(request.target_agent_id));
      if (!target) {
        return {
          ok: false,
          code: 'UNKNOWN_DELEGATE',
          error: `Delegation target "${asString(request.target_agent_id)}" is not a registered department agent.`,
        };
      }
      if (target.id === definition.id) {
        return {
          ok: false,
          code: 'SELF_DELEGATION_FORBIDDEN',
          error: `Agent "${definition.id}" cannot delegate to itself.`,
        };
      }
      if (!definition.allowed_delegate_ids.includes(target.id)) {
        return {
          ok: false,
          code: 'DELEGATION_TARGET_NOT_ALLOWED',
          error: `Agent "${definition.id}" is not allowed to delegate to "${target.id}".`,
        };
      }
      if (!project.allowed_agent_ids.includes(target.id)) {
        return {
          ok: false,
          code: 'DELEGATE_NOT_IN_PROJECT',
          error: `Agent "${target.id}" is not allowed in project "${project.project_id}".`,
        };
      }
      if (!target.allowed_actions.includes(asString(request.action))) {
        return {
          ok: false,
          code: 'ACTION_NOT_ALLOWED_FOR_DELEGATE',
          error: `Agent "${target.id}" is not allowed to perform action "${asString(request.action)}".`,
        };
      }
      if (parent.depth + 1 > parent.max_depth || parent.depth + 1 > this.maxDelegationDepth) {
        return {
          ok: false,
          code: 'MAX_DELEGATION_DEPTH_EXCEEDED',
          error: `Delegation depth limit reached at parent task "${parent.task_id}".`,
        };
      }
      if (this.hasAncestorAgent(parent, target.id)) {
        return {
          ok: false,
          code: 'DELEGATION_CYCLE_DETECTED',
          error: `Delegation cycle detected: "${target.id}" already appears in the parent chain.`,
        };
      }
      const title = asString(request.title).trim();
      const description = asString(request.description).trim();
      if (title.length < 1 || title.length > 200) {
        return { ok: false, code: 'INVALID_DELEGATION_TITLE', error: 'Delegation title must be 1-200 characters.' };
      }
      if (description.length < 1 || description.length > 2000) {
        return {
          ok: false,
          code: 'INVALID_DELEGATION_DESCRIPTION',
          error: 'Delegation description must be 1-2000 characters.',
        };
      }
      if (!isPlainObject(request.input)) {
        return { ok: false, code: 'INVALID_DELEGATION_INPUT', error: 'Delegation input must be an object.' };
      }
      const forbidden = findForbiddenKeys(request.input);
      if (forbidden.length > 0) {
        return {
          ok: false,
          code: 'FORBIDDEN_DELEGATION_FIELDS',
          error: `Delegation input contains forbidden fields: ${forbidden.slice(0, 5).join(', ')}.`,
        };
      }
      const dependsOnKeys = asStringArray(request.depends_on_keys);
      if (dependsOnKeys.includes(key)) {
        return {
          ok: false,
          code: 'SELF_DEPENDENCY_FORBIDDEN',
          error: `Delegation "${key}" cannot depend on itself.`,
        };
      }
      prepared.push({
        key,
        target,
        request: { ...request, title, description, depends_on_keys: dependsOnKeys },
        dependencies: dependsOnKeys,
        taskId: `dtask_${crypto.randomUUID()}`,
      });
    }

    const idByKey = new Map(prepared.map((item) => [item.key, item.taskId]));
    for (const item of prepared) {
      for (const depKey of item.dependencies) {
        if (!idByKey.has(depKey)) {
          return {
            ok: false,
            code: 'UNKNOWN_DEPENDENCY_KEY',
            error: `Delegation "${item.key}" depends on unknown key "${depKey}".`,
          };
        }
      }
    }
    const dependencyGraph = new Map(
      prepared.map((item) => [item.key, item.dependencies]),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const findCycle = (key: string): string | null => {
      if (visiting.has(key)) return key;
      if (visited.has(key)) return null;
      visiting.add(key);
      for (const dependency of dependencyGraph.get(key) ?? []) {
        const cycle = findCycle(dependency);
        if (cycle) return cycle;
      }
      visiting.delete(key);
      visited.add(key);
      return null;
    };
    for (const item of prepared) {
      const cycle = findCycle(item.key);
      if (cycle) {
        return {
          ok: false,
          code: 'DELEGATION_DEPENDENCY_CYCLE',
          error: `Delegation dependency cycle detected involving "${cycle}".`,
        };
      }
    }

    const nowIso = this.clock().toISOString();
    const createdTasks: DelegationTaskRecord[] = [];
    for (const item of prepared) {
      const childId = item.taskId;
      const task: DelegationTaskRecord = {
        task_id: childId,
        project_id: parent.project_id,
        parent_task_id: parent.task_id,
        root_task_id: parent.root_task_id,
        agent_id: item.target.id,
        department: item.target.department,
        status: 'CREATED',
        action: item.request.action,
        resource_id: parent.resource_id,
        environment: 'sandbox',
        title: item.request.title,
        description: item.request.description,
        input: {
          ...item.request.input,
          project_id: parent.project_id,
          objective: asString(parent.input.objective, parent.description),
          deliverable: asString(item.request.input.deliverable, item.request.title),
          constraints: asStringArray(parent.input.constraints),
          project_context: isPlainObject(parent.input.project_context)
            ? parent.input.project_context
            : {},
        },
        output: null,
        error: null,
        risk_level: item.target.risk_level,
        approval_id: null,
        approval_required: false,
        depth: parent.depth + 1,
        max_depth: parent.max_depth,
        retry_count: 0,
        max_retries: item.target.max_retries,
        timeout_ms: item.target.timeout_ms,
        idempotency_key: `${parent.task_id}:${item.key}`,
        dependencies: item.dependencies.map((depKey) => idByKey.get(depKey)!),
        child_task_ids: [],
        correlation_id: parent.correlation_id,
        cancellation_requested: false,
        started_at: null,
        finished_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      };
      const created = this.store.createTask({
        task,
        event: makeEvent({
          taskId: childId,
          eventType: 'task.created',
          fromStatus: null,
          toStatus: 'CREATED',
          actorId: definition.id,
          message: `Delegated by "${definition.id}" to "${item.target.id}".`,
          metadata: {
            parent_task_id: parent.task_id,
            delegation_key: item.key,
          },
          nowIso,
        }),
      });
      createdTasks.push(created.task);
      this.auditLogger.logEvent({
        actor_type: 'agent',
        actor_id: definition.id,
        event_type: 'delegation.task.created',
        resource_type: 'task',
        resource_id: childId,
        action: item.request.action,
        outcome: 'success',
        correlation_id: parent.correlation_id,
        metadata: {
          parent_task_id: parent.task_id,
          target_agent_id: item.target.id,
          depth: parent.depth + 1,
        },
      });
    }

    this.store.updateTask({
      taskId: parent.task_id,
      childTaskIds: [
        ...parent.child_task_ids,
        ...createdTasks.map((child) => child.task_id),
      ],
      updatedAt: nowIso,
      event: makeEvent({
        taskId: parent.task_id,
        eventType: 'task.children.created',
        fromStatus: parent.status,
        toStatus: parent.status,
        actorId: definition.id,
        message: `Created ${createdTasks.length} validated child task(s).`,
        metadata: { child_task_ids: createdTasks.map((child) => child.task_id) },
        nowIso,
      }),
    });

    this.enqueueReadyTasks(parent.project_id);
    return { ok: true, tasks: createdTasks };
  }

  private hasAncestorAgent(task: DelegationTaskRecord, agentId: string): boolean {
    if (task.agent_id === agentId) {
      return true;
    }
    let cursor = task.parent_task_id;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = this.store.getTask(cursor);
      if (!parent) break;
      if (parent.agent_id === agentId) {
        return true;
      }
      cursor = parent.parent_task_id;
    }
    return false;
  }

  private enqueueReadyTasks(projectId: string): void {
    const created = this.store.listTasks({
      projectId,
      status: 'CREATED',
      limit: 500,
    });
    for (const task of created) {
      const latest = this.store.getTask(task.task_id);
      if (!latest || latest.status !== 'CREATED') continue;
      if (latest.cancellation_requested) {
        this.cancelOne(latest, 'system:delegation_engine', 'Cancellation requested.');
        continue;
      }
      const dependencyTasks = latest.dependencies
        .map((depId) => this.store.getTask(depId))
        .filter((dep): dep is DelegationTaskRecord => dep !== null);
      if (dependencyTasks.length !== latest.dependencies.length) {
        this.failTask(latest, this.definitionOrFail(latest), {
          code: 'DEPENDENCY_NOT_FOUND',
          message: 'One or more dependency tasks no longer exist.',
          retryable: false,
        });
        continue;
      }
      if (dependencyTasks.some((dep) => dep.status === 'CANCELLED')) {
        this.cancelOne(latest, 'system:delegation_engine', 'A dependency was cancelled.');
        continue;
      }
      const allTerminal = dependencyTasks.every((dep) =>
        ['COMPLETED', 'FAILED', 'CANCELLED'].includes(dep.status),
      );
      if (!allTerminal) {
        continue;
      }
      const allCompleted = dependencyTasks.every((dep) => dep.status === 'COMPLETED');
      const allowPartial = latest.input.allow_partial_dependencies === true;
      if (!allCompleted && !allowPartial) {
        this.failTask(latest, this.definitionOrFail(latest), {
          code: 'DEPENDENCY_FAILED',
          message: 'A dependency failed or was cancelled; this task cannot run.',
          retryable: false,
        });
        continue;
      }
      const validating = this.transition(
        latest,
        'VALIDATING',
        'system:delegation_engine',
        'Dependencies satisfied; validating task.',
      );
      if (validating) {
        this.transition(
          validating,
          'QUEUED',
          'system:delegation_engine',
          'Task queued for execution.',
        );
      }
    }
  }

  private completeTask(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    output: Record<string, unknown>,
  ): DelegationTaskRecord | null {
    const latest = this.store.getTask(task.task_id) ?? task;
    if (latest.status === 'CANCELLED') {
      return latest;
    }
    const nowIso = this.clock().toISOString();
    const redacted = this.redact(output);
    const updated = this.store.updateTask({
      taskId: latest.task_id,
      status: 'COMPLETED',
      output: redacted,
      error: null,
      finishedAt: nowIso,
      updatedAt: nowIso,
      event: makeEvent({
        taskId: latest.task_id,
        eventType: 'task.completed',
        fromStatus: latest.status,
        toStatus: 'COMPLETED',
        actorId: definition.id,
        message: `Agent "${definition.id}" completed task.`,
        metadata: {
          model_assisted: redacted.model_assisted === true,
          deliverable_count: Array.isArray(redacted.deliverables)
            ? redacted.deliverables.length
            : 0,
        },
        nowIso,
      }),
    });
    this.store.updateDepartmentAgentState({
      agentId: definition.id,
      currentTaskId: null,
      health: 'healthy',
      incrementCompleted: true,
      lastHeartbeatAt: nowIso,
      updatedAt: nowIso,
    });
    this.auditLogger.logEvent({
      actor_type: 'agent',
      actor_id: definition.id,
      event_type: 'delegation.task.completed',
      resource_type: 'task',
      resource_id: latest.task_id,
      action: latest.action,
      outcome: 'success',
      correlation_id: latest.correlation_id,
      metadata: { project_id: latest.project_id },
    });
    this.enqueueReadyTasks(latest.project_id);
    const root = this.store.getTask(latest.root_task_id);
    if (root) this.maybeCreateConsolidation(root);
    return updated;
  }

  private failTask(
    task: DelegationTaskRecord,
    definition: DepartmentAgentDefinition,
    error: { code: string; message: string; retryable: boolean },
  ): DelegationTaskRecord | null {
    const latest = this.store.getTask(task.task_id) ?? task;
    if (latest.status === 'CANCELLED') {
      return latest;
    }
    const redactedMessage = redactSensitiveText(
      error.message,
      this.getKnownSecrets(),
    ).value;
    const redactedError = {
      code: error.code,
      message: redactedMessage,
      retryable: error.retryable,
    };
    const nowIso = this.clock().toISOString();
    if (error.retryable && latest.retry_count < latest.max_retries) {
      const retrying = this.transition(
        latest,
        'RETRYING',
        'system:delegation_engine',
        `Task failed (${error.code}); scheduling retry ${latest.retry_count + 1}/${latest.max_retries}.`,
        {
          error: redactedError,
          retryCount: latest.retry_count + 1,
          metadata: { error_code: error.code },
        },
      );
      if (retrying) {
        const queued = this.transition(
          retrying,
          'QUEUED',
          'system:delegation_engine',
          'Task re-queued for retry.',
          { startedAt: null },
        );
        this.auditLogger.logFailure({
          actor_type: 'agent',
          actor_id: definition.id,
          resource_type: 'task',
          resource_id: latest.task_id,
          action: latest.action,
          error_code: error.code,
          correlation_id: latest.correlation_id,
          metadata: { retry_count: latest.retry_count + 1 },
        });
        return queued;
      }
    }
    const updated = this.transition(
      latest,
      'FAILED',
      'system:delegation_engine',
      `Task failed permanently (${error.code}): ${redactedMessage}`,
      {
        error: redactedError,
        finishedAt: nowIso,
        metadata: { error_code: error.code },
      },
    );
    this.store.updateDepartmentAgentState({
      agentId: definition.id,
      currentTaskId: null,
      health: 'degraded',
      incrementFailed: true,
      lastHeartbeatAt: nowIso,
      updatedAt: nowIso,
    });
    this.auditLogger.logFailure({
      actor_type: 'agent',
      actor_id: definition.id,
      resource_type: 'task',
      resource_id: latest.task_id,
      action: latest.action,
      error_code: error.code,
      correlation_id: latest.correlation_id,
      metadata: { project_id: latest.project_id },
    });
    this.enqueueReadyTasks(latest.project_id);
    const root = this.store.getTask(latest.root_task_id);
    if (root) this.maybeCreateConsolidation(root);
    return updated;
  }

  private maybeCreateConsolidation(parent: DelegationTaskRecord): void {
    const latestParent = this.store.getTask(parent.task_id);
    if (!latestParent || latestParent.agent_id !== 'ceo_strategy') {
      return;
    }
    if (latestParent.output?.delegations_created !== true) {
      return;
    }
    const children = this.store.listChildren(latestParent.task_id);
    const workChildren = children.filter(
      (child) => child.input.mode !== 'consolidate',
    );
    if (workChildren.length === 0) {
      return;
    }
    if (workChildren.some((child) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(child.status))) {
      return;
    }
    if (children.some((child) => child.input.mode === 'consolidate')) {
      return;
    }
    const ceo = getDepartmentAgentDefinition('ceo_strategy')!;
    const nowIso = this.clock().toISOString();
    const taskId = `dtask_${crypto.randomUUID()}`;
    const task: DelegationTaskRecord = {
      task_id: taskId,
      project_id: latestParent.project_id,
      parent_task_id: latestParent.task_id,
      root_task_id: latestParent.root_task_id,
      agent_id: ceo.id,
      department: ceo.department,
      status: 'CREATED',
      action: 'agent:plan',
      resource_id: latestParent.resource_id,
      environment: latestParent.environment,
      title: 'Consolidate department reports',
      description: 'CEO consolidates completed department work into the final owner report.',
      input: {
        project_id: latestParent.project_id,
        objective: asString(latestParent.input.objective, latestParent.description),
        deliverable: 'consolidated_project_report',
        constraints: asStringArray(latestParent.input.constraints),
        project_context: isPlainObject(latestParent.input.project_context)
          ? latestParent.input.project_context
          : {},
        mode: 'consolidate',
        allow_partial_dependencies: true,
      },
      output: null,
      error: null,
      risk_level: ceo.risk_level,
      approval_id: null,
      approval_required: false,
      depth: latestParent.depth + 1,
      max_depth: latestParent.max_depth,
      retry_count: 0,
      max_retries: ceo.max_retries,
      timeout_ms: ceo.timeout_ms,
      idempotency_key: `${latestParent.task_id}:consolidate`,
      dependencies: workChildren.map((child) => child.task_id),
      child_task_ids: [],
      correlation_id: latestParent.correlation_id,
      cancellation_requested: false,
      started_at: null,
      finished_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    this.store.createTask({
      task,
      event: makeEvent({
        taskId,
        eventType: 'task.created',
        fromStatus: null,
        toStatus: 'CREATED',
        actorId: 'system:delegation_engine',
        message: 'Created CEO consolidation task after department work reached terminal state.',
        metadata: { parent_task_id: latestParent.task_id },
        nowIso,
      }),
    });
    this.enqueueReadyTasks(latestParent.project_id);
  }

  decideDelegationApproval(input: {
    approval_id: string;
    decision: 'approved' | 'rejected';
    reviewer: import('../core/approvals/index.ts').TrustedReviewerContext;
    reason: string;
    correlation_id: string;
  }):
    | { ok: true; approval: ApprovalRecord; task: DelegationTaskRecord }
    | { ok: false; code: string; error: string } {
    const decision = this.approvals.decideApproval({
      approval_id: input.approval_id,
      decision: input.decision,
      reviewer: input.reviewer,
      reason: input.reason,
      correlation_id: input.correlation_id,
    });
    if (!decision.ok) {
      return { ok: false, code: decision.code, error: decision.error };
    }
    const approval = decision.record;
    const task = this.store.getTask(approval.task_id);
    if (!task) {
      return {
        ok: false,
        code: 'DELEGATION_TASK_NOT_FOUND',
        error: `Delegation task "${approval.task_id}" was not found.`,
      };
    }
    if (task.status !== 'WAITING_FOR_APPROVAL') {
      return {
        ok: true,
        approval,
        task,
      };
    }
    const definition = this.definitionOrFail(task);
    if (input.decision === 'rejected') {
      const failed = this.failTask(task, definition, {
        code: 'APPROVAL_REJECTED',
        message: `Owner rejected approval: ${input.reason}`,
        retryable: false,
      });
      return { ok: true, approval, task: failed ?? task };
    }
    const queued = this.transition(
      task,
      'QUEUED',
      input.reviewer.actor_id,
      'Owner approved the task; it will be consumed at execution time.',
      {
        approvalId: approval.id,
        approvalRequired: true,
        metadata: { approval_id: approval.id },
      },
    );
    this.auditLogger.logApprovalDecision({
      actor_type: 'owner',
      actor_id: input.reviewer.actor_id,
      approval_id: approval.id,
      action: approval.action,
      outcome: 'success',
      correlation_id: input.correlation_id,
      metadata: { task_id: task.task_id },
    });
    return { ok: true, approval, task: queued ?? task };
  }

  cancelTask(
    taskId: string,
    ctx: DelegationActorContext,
    reason: string,
  ):
    | { ok: true; cancelled_count: number; task: DelegationTaskRecord }
    | { ok: false; code: string; error: string } {
    if (ctx.actor.type !== 'owner' || ctx.actor.trusted_authenticated !== true) {
      return {
        ok: false,
        code: 'OWNER_AUTHENTICATION_REQUIRED',
        error: 'Only the authenticated human owner may cancel delegation tasks.',
      };
    }
    const task = this.store.getTask(taskId);
    if (!task) {
      return { ok: false, code: 'TASK_NOT_FOUND', error: `Task "${taskId}" was not found.` };
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
      return {
        ok: false,
        code: 'TASK_ALREADY_TERMINAL',
        error: `Task "${taskId}" is already "${task.status}".`,
      };
    }
    const cancelledCount = this.cancelTree(task, ctx.actor.id, reason);
    const updated = this.store.getTask(taskId) ?? task;
    this.auditLogger.logEvent({
      actor_type: 'owner',
      actor_id: ctx.actor.id,
      event_type: 'delegation.task.cancelled',
      resource_type: 'task',
      resource_id: taskId,
      action: task.action,
      outcome: 'cancelled',
      correlation_id: ctx.correlation_id,
      metadata: { cancelled_count: cancelledCount, reason },
    });
    return { ok: true, cancelled_count: cancelledCount, task: updated };
  }

  private cancelTree(task: DelegationTaskRecord, actorId: string, reason: string): number {
    let count = 0;
    const stack = [task];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current.task_id)) continue;
      seen.add(current.task_id);
      for (const child of this.store.listChildren(current.task_id)) {
        if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(child.status)) {
          stack.push(child);
        }
      }
      if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status)) {
        this.cancelOne(current, actorId, reason);
        count += 1;
      }
    }
    return count;
  }

  private cancelOne(
    task: DelegationTaskRecord,
    actorId: string,
    reason: string,
  ): DelegationTaskRecord {
    const latest = this.store.getTask(task.task_id) ?? task;
    if (latest.status === 'CANCELLED') {
      return latest;
    }
    this.activeControllers.get(latest.task_id)?.abort(new Error(reason));
    const nowIso = this.clock().toISOString();
    const updated = this.store.updateTask({
      taskId: latest.task_id,
      status: 'CANCELLED',
      cancellationRequested: true,
      finishedAt: nowIso,
      updatedAt: nowIso,
      error: { code: 'CANCELLED_BY_OWNER', message: reason, retryable: false },
      event: makeEvent({
        taskId: latest.task_id,
        eventType: 'task.cancelled',
        fromStatus: latest.status,
        toStatus: 'CANCELLED',
        actorId,
        message: reason,
        metadata: {},
        nowIso,
      }),
    });
    this.store.updateDepartmentAgentState({
      agentId: latest.agent_id,
      currentTaskId: null,
      health: 'unknown',
      updatedAt: nowIso,
    });
    return updated ?? latest;
  }

  watchdogScan(): ReturnType<DelegationStore['listAlerts']> {
    const nowIso = this.clock().toISOString();
    const existing = this.store.listAlerts(200);
    const created: ReturnType<DelegationStore['listAlerts']> = [];
    const hasOpen = (code: string, taskId?: string | null, workerId?: string | null) =>
      existing.some(
        (alert) =>
          alert.acknowledged_at === null &&
          alert.code === code &&
          alert.task_id === (taskId ?? null) &&
          alert.worker_id === (workerId ?? null),
      );

    for (const task of this.store.listStaleTasks(nowIso, this.stuckTaskAfterMs)) {
      if (hasOpen('STUCK_TASK', task.task_id, null)) continue;
      created.push(
        this.store.createAlert({
          alert_id: `alert_${crypto.randomUUID()}`,
          severity: 'warning',
          code: 'STUCK_TASK',
          message: `Task "${task.task_id}" has been ${task.status} without update for more than ${Math.round(this.stuckTaskAfterMs / 1000)}s.`,
          task_id: task.task_id,
          agent_id: task.agent_id,
          worker_id: null,
          created_at: nowIso,
          acknowledged_at: null,
        }),
      );
    }

    for (const worker of this.store.listWorkerHeartbeats()) {
      if (worker.health === 'healthy' || worker.health === 'unknown') continue;
      if (hasOpen('WORKER_UNAVAILABLE', null, worker.worker_id)) continue;
      created.push(
        this.store.createAlert({
          alert_id: `alert_${crypto.randomUUID()}`,
          severity: worker.health === 'offline' ? 'critical' : 'warning',
          code: 'WORKER_UNAVAILABLE',
          message: `Model worker "${worker.worker_id}" is ${worker.health}${worker.last_error ? `: ${worker.last_error}` : '.'}`,
          task_id: null,
          agent_id: null,
          worker_id: worker.worker_id,
          created_at: nowIso,
          acknowledged_at: null,
        }),
      );
    }

    const metrics = this.getQueueMetrics();
    if (metrics.queued > 50 && !hasOpen('QUEUE_BACKLOG', null, null)) {
      created.push(
        this.store.createAlert({
          alert_id: `alert_${crypto.randomUUID()}`,
          severity: 'warning',
          code: 'QUEUE_BACKLOG',
          message: `Delegation queue depth is ${metrics.queued}; investigate worker and task throughput.`,
          task_id: null,
          agent_id: null,
          worker_id: null,
          created_at: nowIso,
          acknowledged_at: null,
        }),
      );
    }
    return created;
  }

  async refreshWorkerHealth(): Promise<ReturnType<DelegationStore['listWorkerHeartbeats']>[number] | null> {
    if (!this.modelWorker) {
      return null;
    }
    const health = await this.modelWorker.health(5_000);
    const nowIso = this.clock().toISOString();
    const record = this.store.upsertWorkerHeartbeat({
      worker_id: this.modelWorker.worker_id,
      runtime_type: this.modelWorker.runtime_type,
      endpoint: health.endpoint,
      health: health.healthy ? 'healthy' : 'offline',
      active_jobs: 0,
      queue_length: 0,
      latency_ms: health.latency_ms,
      models: health.models,
      last_error: health.error ?? null,
      last_heartbeat_at: nowIso,
      updated_at: nowIso,
    });
    if (!health.healthy) {
      const existing = this.store
        .listAlerts(100)
        .some(
          (alert) =>
            alert.acknowledged_at === null &&
            alert.code === 'WORKER_UNAVAILABLE' &&
            alert.worker_id === record.worker_id,
        );
      if (!existing) {
        this.store.createAlert({
          alert_id: `alert_${crypto.randomUUID()}`,
          severity: 'critical',
          code: 'WORKER_UNAVAILABLE',
          message: `Model worker "${record.worker_id}" health check failed: ${health.error ?? 'unknown error'}`,
          task_id: null,
          agent_id: null,
          worker_id: record.worker_id,
          created_at: nowIso,
          acknowledged_at: null,
        });
      }
    }
    return record;
  }

  async getSandboxCapabilities(): Promise<Record<string, unknown> | null> {
    if (!this.sandboxExecutor?.getCapabilities) {
      return null;
    }
    return this.sandboxExecutor.getCapabilities();
  }

  async getOverview(): Promise<Record<string, unknown>> {
    return {
      agents: this.listAgents(),
      projects: this.store.listProjects(20),
      metrics: this.getQueueMetrics(),
      recent_tasks: this.store.listTasks({ limit: 30 }),
      recent_events: this.store.listRecentEvents(30),
      alerts: this.store.listAlerts(30),
      workers: this.store.listWorkerHeartbeats(),
      sandbox: await this.getSandboxCapabilities(),
    };
  }

  recoverOnStartup(): { requeued: string[]; failed: string[] } {
    const report = this.store.recoverInterruptedTasks(this.clock().toISOString());
    this.auditLogger.logEvent({
      actor_type: 'system',
      actor_id: 'system:delegation_engine',
      event_type: 'delegation.recovery.completed',
      resource_type: 'system',
      resource_id: 'delegation_engine',
      action: 'agent:monitor',
      outcome: 'success',
      correlation_id: `corr_recovery_${Date.now()}`,
      metadata: { requeued: report.requeued.length, failed: report.failed.length },
    });
    return report;
  }
}
