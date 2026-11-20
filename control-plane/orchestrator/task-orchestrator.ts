import crypto from 'node:crypto';

import type { TaskError, TaskStatus } from '../../contracts/types/index.ts';
import { validateTask } from '../../contracts/validation/index.ts';
import {
  ApprovalService,
  type ApprovalRecord,
} from '../../core/approvals/index.ts';
import type { AuditLogger } from '../../core/audit/index.ts';
import {
  POLICY_ACTION_CATALOG,
  evaluatePolicyWithAudit,
  type PolicyActor,
} from '../../core/policy/index.ts';
import type { ComputeNode, HardwareManager } from '../../intelligence/hardware/index.ts';
import type { ModelLifecycleManager } from '../../intelligence/lifecycle/index.ts';
import type { LocalModelRegistry } from '../../intelligence/model-registry/local-model-registry.ts';
import type { ModelRouter } from '../../intelligence/router/index.ts';
import type { RuntimeManager } from '../../intelligence/runtime/index.ts';
import {
  toContractTask,
  type LeaseRecoveryReport,
  type OrchestratedTaskRecord,
  type OrchestrationStore,
  type ScheduleRecord,
  type TaskEventRecord,
} from '../db/index.ts';
import type {
  CreateScheduleInput,
  DecideApprovalForTaskInput,
  ExternalTaskActionHandler,
  SubmitTaskInput,
  SubmitTaskResult,
  TaskDetailSnapshot,
  TaskHandlerOutcome,
  TaskSubmissionContext,
  WorkerTickReport,
} from './orchestrator-types.ts';

export interface TaskOrchestratorOptions {
  store: OrchestrationStore;
  designatedOwnerId: string;
  systemConfig: unknown;
  auditLogger: AuditLogger;
  registry: LocalModelRegistry;
  hardware: HardwareManager;
  lifecycle: ModelLifecycleManager;
  runtime: RuntimeManager;
  router: ModelRouter;
  workerId?: string;
  maxConcurrentRunning?: number;
  leaseDurationMs?: number;
  externalHandlers?: Record<string, ExternalTaskActionHandler>;
  clock?: () => Date;
}

export class TaskOrchestrator {
  private readonly store: OrchestrationStore;
  private readonly approvals: ApprovalService;
  private readonly systemConfig: unknown;
  private readonly auditLogger: AuditLogger;
  private readonly registry: LocalModelRegistry;
  private readonly hardware: HardwareManager;
  private readonly lifecycle: ModelLifecycleManager;
  private readonly runtime: RuntimeManager;
  private readonly router: ModelRouter;
  private readonly workerId: string;
  private readonly maxConcurrentRunning: number;
  private readonly leaseDurationMs: number;
  private readonly externalHandlers: Map<string, ExternalTaskActionHandler>;
  private readonly clock: () => Date;
  private readonly activeAbortControllers = new Map<string, AbortController>();
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private loopBusy = false;

  constructor(options: TaskOrchestratorOptions) {
    this.store = options.store;
    this.systemConfig = options.systemConfig;
    this.auditLogger = options.auditLogger;
    this.registry = options.registry;
    this.hardware = options.hardware;
    this.lifecycle = options.lifecycle;
    this.runtime = options.runtime;
    this.router = options.router;
    this.workerId = options.workerId ?? `worker_${crypto.randomUUID().slice(0, 8)}`;
    this.maxConcurrentRunning = Math.max(1, options.maxConcurrentRunning ?? 2);
    this.leaseDurationMs = Math.max(5_000, options.leaseDurationMs ?? 60_000);
    this.clock = options.clock ?? (() => new Date());
    this.externalHandlers = new Map(
      Object.entries(options.externalHandlers ?? {}),
    );

    this.approvals = new ApprovalService({
      designatedOwnerId: options.designatedOwnerId,
      store: this.store,
      auditLogger: this.auditLogger,
      clock: this.clock,
    });
  }

  getApprovalService(): ApprovalService {
    return this.approvals;
  }

  getWorkerId(): string {
    return this.workerId;
  }

  registerExternalHandler(
    action: string,
    handler: ExternalTaskActionHandler,
  ): void {
    this.externalHandlers.set(action, handler);
  }

  recoverOnStartup(): LeaseRecoveryReport {
    const nowIso = this.clock().toISOString();
    return this.store.recoverAbandonedLeases(nowIso);
  }

  startWorkerLoop(intervalMs = 1500): void {
    if (this.loopTimer) return;
    this.recoverOnStartup();
    this.loopTimer = setInterval(() => {
      if (this.loopBusy) return;
      this.loopBusy = true;
      void this.runWorkerTick().finally(() => {
        this.loopBusy = false;
      });
    }, Math.max(250, intervalMs));
  }

  stopWorkerLoop(): void {
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    for (const controller of this.activeAbortControllers.values()) {
      controller.abort();
    }
    this.activeAbortControllers.clear();
  }

  submitTask(
    input: SubmitTaskInput,
    ctx: TaskSubmissionContext,
  ): SubmitTaskResult {
    const now = this.clock();
    const nowIso = now.toISOString();

    if (input.idempotency_key) {
      const existing = this.store.getTaskByIdempotencyKey(
        input.idempotency_key,
      );
      if (existing) {
        return { ok: true, duplicate: true, task: existing };
      }
    }

    const actionSpec = POLICY_ACTION_CATALOG[input.action];
    if (!actionSpec) {
      this.auditLogger.logPolicyDecision({
        actor_type: ctx.actor.type,
        actor_id: ctx.actor.id,
        resource_type: 'task',
        resource_id: input.resource_id || 'unknown_resource',
        action: input.action || 'unknown_action',
        decision: 'deny',
        reason_code: 'UNKNOWN_ACTION',
        correlation_id: ctx.correlation_id,
      });
      return {
        ok: false,
        code: 'UNKNOWN_ACTION',
        error: `Action "${input.action}" is not in the recognized policy catalog.`,
      };
    }

    const priority = Math.min(100, Math.max(0, Math.round(input.priority ?? 50)));
    const maxRetries = Math.min(5, Math.max(0, Math.round(input.max_retries ?? 0)));
    const timeoutMs = Math.min(
      300_000,
      Math.max(500, Math.round(input.timeout_ms ?? 30_000)),
    );

    if (input.deadline_at) {
      const deadlineMs = new Date(input.deadline_at).getTime();
      if (!Number.isFinite(deadlineMs) || deadlineMs <= now.getTime()) {
        return {
          ok: false,
          code: 'INVALID_DEADLINE',
          error: 'Task deadline_at must be a valid future ISO timestamp.',
        };
      }
    }

    const taskId = `task_${crypto.randomUUID()}`;
    const candidateRecord: OrchestratedTaskRecord = {
      id: taskId,
      type: input.type,
      title: input.title,
      description: input.description,
      status: 'queued',
      autonomy_level: input.autonomy_level,
      environment: input.environment,
      action: input.action,
      resource_id: input.resource_id,
      declared_scopes: [...input.declared_scopes],
      priority,
      idempotency_key: input.idempotency_key?.trim() || null,
      idempotent_action: input.idempotent_action ?? true,
      deadline_at: input.deadline_at ?? null,
      retry_count: 0,
      max_retries: maxRetries,
      timeout_ms: timeoutMs,
      next_run_at: nowIso,
      schedule_id: input.schedule_id ?? null,
      requested_by: ctx.actor.id,
      assigned_agent_id: input.assigned_agent_id ?? null,
      input: input.input ?? {},
      result: null,
      error: null,
      approval_ids: [],
      created_at: nowIso,
      updated_at: nowIso,
      schema_version: '1.0.0',
    };

    const contractCheck = validateTask(toContractTask(candidateRecord));
    if (!contractCheck.valid) {
      return {
        ok: false,
        code: 'CONTRACT_VALIDATION_FAILED',
        error: contractCheck.errors.map((e) => e.message).join('; '),
      };
    }

    // Policy evaluation gates every task before queueing.
    const policy = evaluatePolicyWithAudit({
      actor: ctx.actor,
      action: candidateRecord.action,
      resource: { id: candidateRecord.resource_id, type: 'task' },
      environment: candidateRecord.environment,
      declared_scopes: candidateRecord.declared_scopes,
      owner_confirmed_l4: input.owner_confirmed_l4,
      system_config: this.systemConfig,
      audit_logger: this.auditLogger,
      correlation_id: ctx.correlation_id,
      now,
    });

    let initialStatus: TaskStatus = 'queued';
    let createdApprovalId: string | undefined;

    if (policy.decision === 'deny') {
      return {
        ok: false,
        code: policy.reason_code,
        error: policy.reason,
      };
    }

    if (policy.decision === 'require_approval') {
      const expiresAt =
        candidateRecord.deadline_at ??
        new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      const approvalRes = this.approvals.requestApproval({
        task_id: candidateRecord.id,
        action: candidateRecord.action,
        requested_by: ctx.actor.id,
        environment: candidateRecord.environment,
        reason: `${candidateRecord.title}: ${candidateRecord.description}`,
        scope: {
          resources: [candidateRecord.resource_id],
          permissions: [actionSpec.required_scope],
          single_use: true,
          expires_at: expiresAt,
        },
        correlation_id: ctx.correlation_id,
      });

      if (!approvalRes.ok) {
        return {
          ok: false,
          code: approvalRes.code,
          error: approvalRes.error,
        };
      }

      initialStatus = 'waiting_for_approval';
      createdApprovalId = approvalRes.record.id;
      candidateRecord.status = 'waiting_for_approval';
      candidateRecord.approval_ids = [approvalRes.record.id];
    }

    const initialEvent: TaskEventRecord = {
      event_id: `evt_${crypto.randomUUID()}`,
      task_id: candidateRecord.id,
      event_type:
        initialStatus === 'waiting_for_approval'
          ? 'task.created_awaiting_approval'
          : 'task.created_queued',
      from_status: null,
      to_status: initialStatus,
      actor_id: ctx.actor.id,
      message:
        initialStatus === 'waiting_for_approval'
          ? `Task created and queued in approval inbox (${createdApprovalId}).`
          : `Task created and queued at priority ${priority}.`,
      metadata: {
        action: candidateRecord.action,
        environment: candidateRecord.environment,
        priority,
        approval_id: createdApprovalId ?? null,
      },
      created_at: nowIso,
    };

    const persisted = this.store.createTask({
      task: candidateRecord,
      initialEvent,
    });

    if (!persisted.created) {
      return { ok: true, duplicate: true, task: persisted.task };
    }

    const auditRes = this.auditLogger.logEvent({
      actor_type: ctx.actor.type,
      actor_id: ctx.actor.id,
      event_type: 'task.created',
      resource_type: 'task',
      resource_id: persisted.task.id,
      action: candidateRecord.action,
      outcome: initialStatus === 'waiting_for_approval' ? 'pending' : 'success',
      correlation_id: ctx.correlation_id,
      approval_id: createdApprovalId ?? null,
      metadata: {
        status: initialStatus,
        autonomy_level: persisted.task.autonomy_level,
        environment: persisted.task.environment,
      },
    });
    if (!auditRes.ok) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: auditRes.error,
      };
    }

    return {
      ok: true,
      duplicate: false,
      task: persisted.task,
      approval_id: createdApprovalId,
    };
  }

  decideApprovalAndResumeTask(input: DecideApprovalForTaskInput): {
    ok: true;
    approval: ApprovalRecord;
    task: OrchestratedTaskRecord | null;
  } | {
    ok: false;
    code: string;
    error: string;
  } {
    const decisionRes = this.approvals.decideApproval({
      approval_id: input.approval_id,
      decision: input.decision,
      reviewer: input.reviewer,
      reason: input.reason,
      correlation_id: input.correlation_id,
    });

    if (!decisionRes.ok) {
      return {
        ok: false,
        code: decisionRes.code,
        error: decisionRes.error,
      };
    }

    const task = this.store.getTask(decisionRes.record.task_id);
    if (!task) {
      return { ok: true, approval: decisionRes.record, task: null };
    }

    if (task.status !== 'waiting_for_approval') {
      return { ok: true, approval: decisionRes.record, task };
    }

    const nowIso = this.clock().toISOString();
    const nextStatus: TaskStatus =
      decisionRes.record.status === 'approved' ? 'queued' : 'cancelled';

    const updatedTask = this.store.updateTaskState({
      taskId: task.id,
      status: nextStatus,
      updatedAt: nowIso,
      error:
        nextStatus === 'cancelled'
          ? {
              code: 'APPROVAL_REJECTED',
              message: `Owner rejected approval "${decisionRes.record.id}": ${input.reason}`,
              retryable: false,
            }
          : null,
      nextRunAt: nowIso,
      event: {
        event_id: `evt_${crypto.randomUUID()}`,
        task_id: task.id,
        event_type:
          nextStatus === 'queued'
            ? 'task.approval_granted_queued'
            : 'task.approval_rejected_cancelled',
        from_status: 'waiting_for_approval',
        to_status: nextStatus,
        actor_id: input.reviewer.actor_id,
        message:
          nextStatus === 'queued'
            ? `Owner approved "${decisionRes.record.id}"; task queued for execution.`
            : `Owner rejected "${decisionRes.record.id}"; task cancelled.`,
        metadata: { approval_id: decisionRes.record.id },
        created_at: nowIso,
      },
    });

    return {
      ok: true,
      approval: decisionRes.record,
      task: updatedTask,
    };
  }

  cancelTask(params: {
    taskId: string;
    actor: PolicyActor;
    reason: string;
    correlation_id: string;
  }): { ok: true; task: OrchestratedTaskRecord } | { ok: false; code: string; error: string } {
    if (params.actor.type !== 'owner' || params.actor.trusted_authenticated !== true) {
      return {
        ok: false,
        code: 'OWNER_AUTHENTICATION_REQUIRED',
        error: 'Only the authenticated human owner may cancel orchestrated tasks.',
      };
    }

    const task = this.store.getTask(params.taskId);
    if (!task) {
      return {
        ok: false,
        code: 'TASK_NOT_FOUND',
        error: `Task "${params.taskId}" was not found.`,
      };
    }

    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
      return {
        ok: false,
        code: 'TASK_ALREADY_TERMINAL',
        error: `Task "${task.id}" is already in terminal state "${task.status}".`,
      };
    }

    const controller = this.activeAbortControllers.get(task.id);
    if (controller) {
      controller.abort();
    }

    const nowIso = this.clock().toISOString();
    const updated = this.store.updateTaskState({
      taskId: task.id,
      status: 'cancelled',
      updatedAt: nowIso,
      error: {
        code: 'CANCELLED_BY_OWNER',
        message: params.reason || 'Cancelled by authenticated human owner.',
        retryable: false,
      },
      event: {
        event_id: `evt_${crypto.randomUUID()}`,
        task_id: task.id,
        event_type: 'task.cancelled',
        from_status: task.status,
        to_status: 'cancelled',
        actor_id: params.actor.id,
        message: params.reason || 'Task cancelled by owner.',
        metadata: {},
        created_at: nowIso,
      },
    })!;

    this.auditLogger.logEvent({
      actor_type: 'owner',
      actor_id: params.actor.id,
      event_type: 'task.cancelled',
      resource_type: 'task',
      resource_id: task.id,
      action: task.action,
      outcome: 'cancelled',
      correlation_id: params.correlation_id,
      metadata: { reason: params.reason },
    });

    return { ok: true, task: updated };
  }

  retryTask(params: {
    taskId: string;
    actor: PolicyActor;
    confirmNonIdempotentRetry?: boolean;
    correlation_id: string;
  }): { ok: true; task: OrchestratedTaskRecord } | { ok: false; code: string; error: string } {
    if (params.actor.type !== 'owner' || params.actor.trusted_authenticated !== true) {
      return {
        ok: false,
        code: 'OWNER_AUTHENTICATION_REQUIRED',
        error: 'Only the authenticated human owner may manually retry failed tasks.',
      };
    }

    const task = this.store.getTask(params.taskId);
    if (!task) {
      return {
        ok: false,
        code: 'TASK_NOT_FOUND',
        error: `Task "${params.taskId}" was not found.`,
      };
    }

    if (task.status !== 'failed') {
      return {
        ok: false,
        code: 'TASK_NOT_RETRYABLE_STATUS',
        error: `Only failed tasks can be retried (current status "${task.status}").`,
      };
    }

    const attempts = this.store.listExecutionAttempts(task.id);
    const anyDispatched = attempts.some((a) => a.external_effect_dispatched);
    if (
      !task.idempotent_action &&
      anyDispatched &&
      params.confirmNonIdempotentRetry !== true
    ) {
      return {
        ok: false,
        code: 'NON_IDEMPOTENT_CONFIRMATION_REQUIRED',
        error:
          'This task previously dispatched a non-idempotent external action. Explicit owner confirmation is required after verifying external state.',
      };
    }

    const nowIso = this.clock().toISOString();
    const updated = this.store.updateTaskState({
      taskId: task.id,
      status: 'queued',
      updatedAt: nowIso,
      error: null,
      retryCount: task.retry_count + 1,
      nextRunAt: nowIso,
      event: {
        event_id: `evt_${crypto.randomUUID()}`,
        task_id: task.id,
        event_type: 'task.manual_retry_queued',
        from_status: 'failed',
        to_status: 'queued',
        actor_id: params.actor.id,
        message: 'Owner manually queued failed task for retry.',
        metadata: {
          confirm_non_idempotent: params.confirmNonIdempotentRetry === true,
        },
        created_at: nowIso,
      },
    })!;

    this.auditLogger.logEvent({
      actor_type: 'owner',
      actor_id: params.actor.id,
      event_type: 'task.retried',
      resource_type: 'task',
      resource_id: task.id,
      action: task.action,
      outcome: 'success',
      correlation_id: params.correlation_id,
      metadata: { retry_count: updated.retry_count },
    });

    return { ok: true, task: updated };
  }

  createSchedule(
    input: CreateScheduleInput,
    actor: PolicyActor,
    correlationId: string,
  ): { ok: true; schedule: ScheduleRecord } | { ok: false; code: string; error: string } {
    if (actor.type !== 'owner' || actor.trusted_authenticated !== true) {
      return {
        ok: false,
        code: 'OWNER_AUTHENTICATION_REQUIRED',
        error: 'Only the authenticated human owner may create task schedules.',
      };
    }

    if (!Number.isInteger(input.interval_seconds) || input.interval_seconds < 10) {
      return {
        ok: false,
        code: 'INVALID_SCHEDULE_INTERVAL',
        error: 'Schedule interval_seconds must be an integer >= 10.',
      };
    }

    if (!POLICY_ACTION_CATALOG[input.task_template.action]) {
      return {
        ok: false,
        code: 'UNKNOWN_ACTION',
        error: `Schedule template action "${input.task_template.action}" is not recognized.`,
      };
    }

    const now = this.clock();
    const nowIso = now.toISOString();
    const nextRunAt =
      input.first_run_at ??
      new Date(now.getTime() + input.interval_seconds * 1000).toISOString();

    const record: ScheduleRecord = {
      id: `sched_${crypto.randomUUID()}`,
      name: input.name.trim(),
      description: input.description.trim(),
      interval_seconds: input.interval_seconds,
      next_run_at: nextRunAt,
      enabled: input.enabled ?? true,
      task_template: input.task_template,
      last_task_id: null,
      last_run_at: null,
      created_by: actor.id,
      created_at: nowIso,
      updated_at: nowIso,
    };

    const created = this.store.createSchedule(record);
    this.auditLogger.logEvent({
      actor_type: 'owner',
      actor_id: actor.id,
      event_type: 'schedule.created',
      resource_type: 'system',
      resource_id: created.id,
      action: input.task_template.action,
      outcome: 'success',
      correlation_id: correlationId,
      metadata: {
        interval_seconds: created.interval_seconds,
        enabled: created.enabled,
      },
    });

    return { ok: true, schedule: created };
  }

  toggleSchedule(params: {
    scheduleId: string;
    enabled: boolean;
    actor: PolicyActor;
    correlation_id: string;
  }): { ok: true; schedule: ScheduleRecord } | { ok: false; code: string; error: string } {
    if (params.actor.type !== 'owner' || params.actor.trusted_authenticated !== true) {
      return {
        ok: false,
        code: 'OWNER_AUTHENTICATION_REQUIRED',
        error: 'Only the authenticated human owner may modify schedules.',
      };
    }
    const updated = this.store.updateScheduleState({
      scheduleId: params.scheduleId,
      enabled: params.enabled,
      updatedAt: this.clock().toISOString(),
    });
    if (!updated) {
      return {
        ok: false,
        code: 'SCHEDULE_NOT_FOUND',
        error: `Schedule "${params.scheduleId}" was not found.`,
      };
    }
    this.auditLogger.logEvent({
      actor_type: 'owner',
      actor_id: params.actor.id,
      event_type: 'schedule.updated',
      resource_type: 'system',
      resource_id: updated.id,
      action: updated.task_template.action,
      outcome: 'success',
      correlation_id: params.correlation_id,
      metadata: { enabled: updated.enabled },
    });
    return { ok: true, schedule: updated };
  }

  tickSchedules(): number {
    const now = this.clock();
    const nowIso = now.toISOString();
    const dueSchedules = this.store.listDueSchedules(nowIso);
    let triggered = 0;

    for (const sched of dueSchedules) {
      const slotKey = `sched:${sched.id}:${sched.next_run_at}`;
      const tmpl = sched.task_template;
      const submission = this.submitTask(
        {
          type: tmpl.type,
          title: `${tmpl.title} (Scheduled)`,
          description: tmpl.description,
          action: tmpl.action,
          resource_id: tmpl.resource_id,
          environment: tmpl.environment,
          autonomy_level: tmpl.autonomy_level,
          declared_scopes: tmpl.declared_scopes,
          priority: tmpl.priority,
          idempotency_key: slotKey,
          idempotent_action: tmpl.idempotent_action,
          max_retries: tmpl.max_retries,
          timeout_ms: tmpl.timeout_ms,
          input: tmpl.input,
          schedule_id: sched.id,
        },
        {
          actor: {
            id: sched.created_by,
            type: 'system',
            trusted_autonomy_level:
              tmpl.autonomy_level === 'L4' ? 'L3' : tmpl.autonomy_level,
            trusted_authenticated: true,
          },
          correlation_id: `corr_sched_${sched.id}`,
        },
      );

      const nextRunAt = new Date(
        now.getTime() + sched.interval_seconds * 1000,
      ).toISOString();
      this.store.updateScheduleState({
        scheduleId: sched.id,
        nextRunAt,
        lastTaskId: submission.ok ? submission.task.id : sched.last_task_id,
        lastRunAt: nowIso,
        updatedAt: nowIso,
      });

      if (submission.ok && !submission.duplicate) {
        triggered += 1;
      }
    }

    return triggered;
  }

  getTaskDetail(taskId: string): TaskDetailSnapshot | null {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    return {
      task,
      events: this.store.listTaskEvents(taskId),
      attempts: this.store.listExecutionAttempts(taskId),
    };
  }

  listTasks(filter?: { status?: TaskStatus; limit?: number }): OrchestratedTaskRecord[] {
    return this.store.listTasks(filter);
  }

  listApprovals(): ApprovalRecord[] {
    return this.store.listAll();
  }

  listSchedules(): ScheduleRecord[] {
    return this.store.listSchedules();
  }

  async runWorkerTick(): Promise<WorkerTickReport> {
    const nowIso = this.clock().toISOString();
    const recovery = this.store.recoverAbandonedLeases(nowIso);
    const schedulesTriggered = this.tickSchedules();

    const leaseToken = `lease_${crypto.randomUUID()}`;
    const leased = this.store.acquireNextTaskLease({
      workerId: this.workerId,
      leaseToken,
      leaseDurationMs: this.leaseDurationMs,
      maxConcurrentRunning: this.maxConcurrentRunning,
      nowIso: this.clock().toISOString(),
    });

    if (!leased) {
      return {
        recovered_abandoned: recovery.recovered_count,
        schedules_triggered: schedulesTriggered,
        task_executed: false,
      };
    }

    const { task, attempt } = leased;
    const abortController = new AbortController();
    this.activeAbortControllers.set(task.id, abortController);
    const timeoutTimer = setTimeout(() => {
      abortController.abort(new Error(`Task execution timed out after ${task.timeout_ms}ms`));
    }, task.timeout_ms);

    let outcome: TaskHandlerOutcome;
    try {
      outcome = await this.executeLeasedTask(task, attempt, abortController.signal, leaseToken);
    } catch (err) {
      const timedOut = abortController.signal.aborted;
      outcome = {
        ok: false,
        error: {
          code: timedOut ? 'EXECUTION_TIMEOUT' : 'UNHANDLED_WORKER_EXCEPTION',
          message:
            err instanceof Error
              ? err.message
              : 'Unhandled worker execution error.',
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timeoutTimer);
      this.activeAbortControllers.delete(task.id);
    }

    const finishNow = this.clock();
    const finishIso = finishNow.toISOString();

    if (outcome.ok) {
      this.store.completeAttempt({
        attemptId: attempt.attempt_id,
        leaseToken,
        attemptStatus: 'succeeded',
        taskStatus: 'succeeded',
        nowIso: finishIso,
        result: outcome.result,
        error: null,
        runtimeType: outcome.runtime_type ?? null,
        modelId: outcome.model_id ?? null,
        event: {
          event_id: `evt_${crypto.randomUUID()}`,
          task_id: task.id,
          event_type: 'task.succeeded',
          from_status: 'running',
          to_status: 'succeeded',
          actor_id: this.workerId,
          message: `Attempt #${attempt.attempt_number} completed successfully.`,
          metadata: {
            attempt_id: attempt.attempt_id,
            runtime_type: outcome.runtime_type ?? null,
            model_id: outcome.model_id ?? null,
          },
          created_at: finishIso,
        },
      });

      this.auditLogger.logEvent({
        actor_type: 'system',
        actor_id: this.workerId,
        event_type: 'task.succeeded',
        resource_type: 'task',
        resource_id: task.id,
        action: task.action,
        outcome: 'success',
        correlation_id: `corr_exec_${attempt.attempt_id}`,
        metadata: {
          attempt_number: attempt.attempt_number,
          runtime_type: outcome.runtime_type ?? null,
          model_id: outcome.model_id ?? null,
        },
      });

      return {
        recovered_abandoned: recovery.recovered_count,
        schedules_triggered: schedulesTriggered,
        task_executed: true,
        executed_task_id: task.id,
        executed_status: 'succeeded',
      };
    }

    // Failure path: check retry eligibility and non-idempotency guard.
    const latestAttempt =
      this.store
        .listExecutionAttempts(task.id)
        .find((a) => a.attempt_id === attempt.attempt_id) ?? attempt;
    const pastDeadline =
      task.deadline_at !== null &&
      new Date(task.deadline_at).getTime() <= finishNow.getTime();
    const nonIdempotentDispatched =
      !task.idempotent_action && latestAttempt.external_effect_dispatched;
    const canRetry =
      outcome.error.retryable === true &&
      !nonIdempotentDispatched &&
      !pastDeadline &&
      task.retry_count < task.max_retries;

    const finalTaskStatus: TaskStatus = canRetry ? 'queued' : 'failed';
    const nextRetryCount = canRetry ? task.retry_count + 1 : task.retry_count;
    const backoffMs = Math.min(30_000, 1000 * 2 ** task.retry_count);
    const nextRunAt = canRetry
      ? new Date(finishNow.getTime() + backoffMs).toISOString()
      : task.next_run_at;
    const attemptStatus =
      outcome.error.code === 'EXECUTION_TIMEOUT' ? 'timed_out' : 'failed';

    const recordedError: TaskError = nonIdempotentDispatched
      ? {
          code: 'NON_IDEMPOTENT_EXECUTION_FAILED',
          message: `${outcome.error.message} (Automatic retry blocked: non-idempotent external effect was dispatched.)`,
          retryable: false,
        }
      : outcome.error;

    this.store.completeAttempt({
      attemptId: attempt.attempt_id,
      leaseToken,
      attemptStatus,
      taskStatus: finalTaskStatus,
      nowIso: finishIso,
      error: recordedError,
      runtimeType: outcome.runtime_type ?? null,
      modelId: outcome.model_id ?? null,
      retryCount: nextRetryCount,
      nextRunAt,
      event: {
        event_id: `evt_${crypto.randomUUID()}`,
        task_id: task.id,
        event_type: canRetry ? 'task.retry_scheduled' : 'task.failed',
        from_status: 'running',
        to_status: finalTaskStatus,
        actor_id: this.workerId,
        message: canRetry
          ? `Attempt #${attempt.attempt_number} failed (${recordedError.code}); scheduled retry ${nextRetryCount}/${task.max_retries}.`
          : `Attempt #${attempt.attempt_number} failed permanently (${recordedError.code}): ${recordedError.message}`,
        metadata: {
          attempt_id: attempt.attempt_id,
          error_code: recordedError.code,
          can_retry: canRetry,
        },
        created_at: finishIso,
      },
    });

    this.auditLogger.logEvent({
      actor_type: 'system',
      actor_id: this.workerId,
      event_type: canRetry ? 'task.retry_scheduled' : 'task.failed',
      resource_type: 'task',
      resource_id: task.id,
      action: task.action,
      outcome: 'failure',
      correlation_id: `corr_exec_${attempt.attempt_id}`,
      metadata: {
        error_code: recordedError.code,
        attempt_number: attempt.attempt_number,
        retry_count: nextRetryCount,
      },
    });

    return {
      recovered_abandoned: recovery.recovered_count,
      schedules_triggered: schedulesTriggered,
      task_executed: true,
      executed_task_id: task.id,
      executed_status: finalTaskStatus,
    };
  }

  private async executeLeasedTask(
    task: OrchestratedTaskRecord,
    attempt: ReturnType<OrchestrationStore['listExecutionAttempts']>[number],
    signal: AbortSignal,
    leaseToken: string,
  ): Promise<TaskHandlerOutcome> {
    if (signal.aborted) {
      return {
        ok: false,
        error: {
          code: 'EXECUTION_CANCELLED',
          message: 'Task aborted before execution started.',
          retryable: false,
        },
      };
    }

    const actionSpec = POLICY_ACTION_CATALOG[task.action];
    if (!actionSpec) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Action "${task.action}" is not in policy catalog.`,
          retryable: false,
        },
      };
    }

    // Load linked approval if required (L3/L4) and consume single-use approval atomically.
    let linkedApproval: ApprovalRecord | null = null;
    if (task.approval_ids.length > 0) {
      const approvalId = task.approval_ids[0]!;
      linkedApproval = this.store.get(approvalId);
      if (actionSpec.required_autonomy === 'L3' || actionSpec.required_autonomy === 'L4') {
        const consumeRes = this.approvals.verifyAndConsumeApproval({
          approval_id: approvalId,
          task_id: task.id,
          action: task.action,
          resource_id: task.resource_id,
          required_scope: actionSpec.required_scope,
          environment: task.environment,
          actor_id: this.workerId,
          correlation_id: `corr_consume_${attempt.attempt_id}`,
        });
        if (!consumeRes.ok) {
          return {
            ok: false,
            error: {
              code: consumeRes.code,
              message: consumeRes.error,
              retryable: false,
            },
          };
        }
        linkedApproval = consumeRes.record;
      }
    }

    const execActor: PolicyActor = {
      id: task.requested_by,
      type:
        actionSpec.owner_exclusive || actionSpec.required_autonomy === 'L4'
          ? 'owner'
          : task.assigned_agent_id
            ? 'agent'
            : 'owner',
      trusted_autonomy_level: task.autonomy_level,
      trusted_authenticated: true,
    };

    const policyCheck = evaluatePolicyWithAudit({
      actor: execActor,
      action: task.action,
      resource: { id: task.resource_id, type: 'task' },
      environment: task.environment,
      declared_scopes: task.declared_scopes,
      approval: linkedApproval,
      owner_confirmed_l4:
        actionSpec.owner_exclusive && linkedApproval === null
          ? execActor.type === 'owner'
          : undefined,
      system_config: this.systemConfig,
      audit_logger: this.auditLogger,
      correlation_id: `corr_exec_policy_${attempt.attempt_id}`,
      now: this.clock(),
    });

    if (!policyCheck.allowed) {
      return {
        ok: false,
        error: {
          code: policyCheck.reason_code,
          message: policyCheck.reason,
          retryable: false,
        },
      };
    }

    // Dispatch by governed task action.
    if (task.action === 'governance:read') {
      return {
        ok: true,
        result: {
          registered_models: this.registry.listModels().map((m) => ({
            model_id: m.model_id,
            runtime_type: m.runtime_type,
            enabled: m.enabled,
            compatibility_status: m.compatibility_status,
            availability: m.availability,
          })),
          compute_nodes: this.hardware.listNodes().map((n: ComputeNode) => ({
            node_id: n.node_id,
            online: n.online,
            location: n.location,
          })),
        },
      };
    }

    if (task.action === 'model:discover') {
      const models = this.registry.listModels();
      const targetModel = models.find((m) => m.controlled_runtime_endpoint);
      if (!targetModel || !targetModel.controlled_runtime_endpoint) {
        return {
          ok: true,
          result: {
            discovered: [],
            note: 'No controlled runtime endpoints registered yet.',
          },
        };
      }
      const discovery = await this.runtime.discoverModels(
        targetModel.runtime_type,
        targetModel.controlled_runtime_endpoint,
        { timeoutMs: task.timeout_ms, signal },
      );
      if (!discovery.ok) {
        return {
          ok: false,
          runtime_type: targetModel.runtime_type,
          error: {
            code: 'RUNTIME_DISCOVERY_FAILED',
            message: discovery.error ?? 'Model discovery failed.',
            retryable: true,
          },
        };
      }
      return {
        ok: true,
        runtime_type: targetModel.runtime_type,
        result: { discovered_models: discovery.models },
      };
    }

    if (task.action === 'model:invoke_local' || task.action === 'proposal:draft') {
      const prompt =
        typeof task.input.prompt === 'string' && task.input.prompt.trim().length > 0
          ? task.input.prompt
          : task.description;
      const preferredModelId =
        typeof task.input.preferred_model_id === 'string'
          ? task.input.preferred_model_id
          : undefined;
      const preferredRuntimeType =
        typeof task.input.preferred_runtime_type === 'string'
          ? (task.input.preferred_runtime_type as Parameters<
              ModelRouter['route']
            >[0]['preferred_runtime_type'])
          : undefined;

      const routed = await this.router.routeAndInfer(
        {
          task_id: task.id,
          required_capabilities: ['chat'],
          min_context_length:
            typeof task.input.min_context_length === 'number'
              ? task.input.min_context_length
              : 1024,
          preferred_model_id: preferredModelId,
          preferred_runtime_type: preferredRuntimeType,
          priority: task.priority >= 75 ? 'high' : task.priority <= 25 ? 'low' : 'normal',
          allow_queue: true,
        },
        {
          request_id: attempt.attempt_id,
          messages: [{ role: 'user', content: prompt }],
          max_tokens:
            typeof task.input.max_tokens === 'number'
              ? task.input.max_tokens
              : 256,
          timeout_ms: task.timeout_ms,
          signal,
        },
        {
          actor: execActor,
          declared_scopes: task.declared_scopes,
          environment: task.environment,
          approval: linkedApproval,
          system_config: this.systemConfig,
          audit_logger: this.auditLogger,
          correlation_id: `corr_infer_${attempt.attempt_id}`,
          now: this.clock(),
        },
      );

      if (!routed.ok || !routed.response) {
        const code = routed.error_code ?? routed.routing.code ?? 'LOCAL_INFERENCE_FAILED';
        const retryable =
          !routed.response?.cancelled &&
          code !== 'MODEL_COMPATIBILITY_UNSUPPORTED' &&
          code !== 'MODEL_COMPATIBILITY_UNTESTED' &&
          code !== 'UNSUPPORTED_AIRLLM_MODALITY' &&
          code !== 'NO_MODELS_REGISTERED';

        return {
          ok: false,
          runtime_type: routed.routing.selected_model?.runtime_type ?? null,
          model_id: routed.routing.selected_model?.model_id ?? null,
          error: {
            code: code.slice(0, 64),
            message: routed.error ?? routed.routing.reason,
            retryable,
          },
        };
      }

      return {
        ok: true,
        runtime_type: routed.response.runtime_type,
        model_id: routed.routing.selected_model?.model_id ?? null,
        result: {
          output_text: routed.response.output_text,
          untrusted_model_output: true,
          finish_reason: routed.response.finish_reason ?? 'stop',
          latency_ms: routed.response.latency_ms,
          paid_api_fallback_used: false,
        },
      };
    }

    const customHandler = this.externalHandlers.get(task.action);
    if (!customHandler) {
      return {
        ok: false,
        error: {
          code: 'NO_HANDLER_FOR_ACTION',
          message: `No runtime handler registered for action "${task.action}".`,
          retryable: false,
        },
      };
    }

    return customHandler({
      task,
      attempt,
      signal,
      markExternalEffectDispatched: () => {
        this.store.markExternalEffectDispatched(attempt.attempt_id, leaseToken);
      },
    });
  }
}
