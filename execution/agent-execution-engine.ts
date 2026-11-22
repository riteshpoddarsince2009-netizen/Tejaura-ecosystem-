import crypto from 'node:crypto';

import type { Approval } from '../contracts/types/index.ts';
import {
  ApprovalService,
  type ApprovalRecord,
} from '../core/approvals/index.ts';
import type { AuditLogger } from '../core/audit/index.ts';
import {
  POLICY_ACTION_CATALOG,
  type PolicyActor,
} from '../core/policy/index.ts';
import type {
  AgentExecutionError,
  AgentExecutionJobRecord,
  AgentExecutionJobStatus,
  AgentExecutionLogRecord,
  AgentExecutionRecoveryReport,
  OrchestrationStore,
} from '../control-plane/db/index.ts';
import type {
  AgentExecutionContext,
  ExecuteAgentJobOutcome,
  SandboxAdapter,
  SandboxPolicyConfig,
  SubmitAgentExecutionInput,
  SubmitAgentExecutionResult,
} from './execution-types.ts';
import { validateSandboxExecution } from './sandbox-policy.ts';
import {
  redactAgentError,
  redactSensitiveText,
  redactSensitiveValue,
} from './secret-redactor.ts';

export interface AgentExecutionEngineOptions {
  store: OrchestrationStore;
  approvals: ApprovalService;
  auditLogger: AuditLogger;
  systemConfig: unknown;
  policyConfig: SandboxPolicyConfig;
  adapters: SandboxAdapter[];
  defaultSandboxProvider?: string;
  clock?: () => Date;
}

export class AgentExecutionEngine {
  private readonly store: OrchestrationStore;
  private approvals: ApprovalService;
  private readonly auditLogger: AuditLogger;
  private readonly systemConfig: unknown;
  private readonly policyConfig: SandboxPolicyConfig;
  private readonly adapters = new Map<string, SandboxAdapter>();
  private readonly defaultProviderId: string;
  private readonly clock: () => Date;
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly inMemoryExecutionInputs = new Map<
    string,
    {
      agent: SubmitAgentExecutionInput['agent'];
      tools: SubmitAgentExecutionInput['tools'];
      browser_allowlist: string[];
      correlation_id: string;
    }
  >();

  constructor(options: AgentExecutionEngineOptions) {
    this.store = options.store;
    this.approvals = options.approvals;
    this.auditLogger = options.auditLogger;
    this.systemConfig = options.systemConfig;
    this.policyConfig = options.policyConfig;
    this.clock = options.clock ?? (() => new Date());

    if (!Array.isArray(options.adapters) || options.adapters.length === 0) {
      throw new Error(
        'AgentExecutionEngine requires at least one registered SandboxAdapter.',
      );
    }

    for (const adapter of options.adapters) {
      this.adapters.set(adapter.providerId, adapter);
    }

    this.defaultProviderId =
      options.defaultSandboxProvider ?? options.adapters[0]!.providerId;
    if (!this.adapters.has(this.defaultProviderId)) {
      throw new Error(
        `Default sandbox provider "${this.defaultProviderId}" is not registered.`,
      );
    }
  }

  bindApprovalService(approvals: ApprovalService): void {
    this.approvals = approvals;
  }

  registerAdapter(adapter: SandboxAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  listAdapters(): Array<{
    providerId: string;
    isolationLevel: SandboxAdapter['isolationLevel'];
    supportsOsIsolation: boolean;
    isolationDisclaimer: string;
  }> {
    return [...this.adapters.values()].map((a) => ({
      providerId: a.providerId,
      isolationLevel: a.isolationLevel,
      supportsOsIsolation: a.supportsOsIsolation,
      isolationDisclaimer: a.isolationDisclaimer,
    }));
  }

  recoverOnStartup(): AgentExecutionRecoveryReport {
    const nowIso = this.clock().toISOString();
    return this.store.recoverInterruptedAgentExecutionJobs(nowIso);
  }

  private getKnownSecrets(): string[] {
    const secrets = [...(this.policyConfig.knownSecretValues ?? [])];
    for (const envName of [
      'TEJAURA_SECRETS_MASTER_KEY',
      'TEJAURA_AIRLLM_WORKER_TOKEN',
    ]) {
      const val = process.env[envName];
      if (typeof val === 'string' && val.trim().length >= 8) {
        secrets.push(val.trim());
      }
    }
    return secrets;
  }

  private buildRedactedLog(params: {
    jobId: string | null;
    taskId: string;
    agentId: string;
    requestedAction: string;
    permissionDecision: AgentExecutionLogRecord['permission_decision'];
    policyReasonCode: string;
    approvalId: string | null;
    outcome: AgentExecutionLogRecord['outcome'];
    summary: string;
    details: Record<string, unknown>;
    nowIso: string;
    forceSecretsRedacted?: boolean;
  }): AgentExecutionLogRecord {
    const knownSecrets = this.getKnownSecrets();
    const sumRedacted = redactSensitiveText(params.summary, knownSecrets);
    const detRedacted = redactSensitiveValue(params.details, knownSecrets);
    const totalRedacted = sumRedacted.redactedCount + detRedacted.redactedCount;

    return {
      log_id: `elog_${crypto.randomUUID()}`,
      job_id: params.jobId,
      task_id: params.taskId,
      agent_id: params.agentId,
      requested_action: params.requestedAction,
      permission_decision: params.permissionDecision,
      policy_reason_code: params.policyReasonCode,
      approval_id: params.approvalId,
      outcome: params.outcome,
      summary: sumRedacted.value,
      details: detRedacted.value as Record<string, unknown>,
      secrets_redacted:
        params.forceSecretsRedacted === true || totalRedacted > 0,
      created_at: params.nowIso,
    };
  }

  submitExecution(
    input: SubmitAgentExecutionInput,
    ctx: AgentExecutionContext,
  ): SubmitAgentExecutionResult {
    const now = this.clock();
    const nowIso = now.toISOString();
    const taskId = input.task?.id ?? input.task_id ?? `task_${crypto.randomUUID()}`;
    const agentId =
      typeof input.agent?.id === 'string' && input.agent.id.trim().length > 0
        ? input.agent.id
        : 'unknown_agent';

    if (input.idempotency_key) {
      const existingJob = this.store.getAgentExecutionJobByIdempotencyKey(
        input.idempotency_key,
      );
      if (existingJob) {
        const log = this.buildRedactedLog({
          jobId: existingJob.job_id,
          taskId: existingJob.task_id,
          agentId: existingJob.agent_id,
          requestedAction: existingJob.requested_action,
          permissionDecision: existingJob.permission_decision,
          policyReasonCode: 'IDEMPOTENT_DUPLICATE_REUSED',
          approvalId: existingJob.approval_id,
          outcome: 'queued',
          summary: `Idempotent duplicate request reused existing job "${existingJob.job_id}".`,
          details: { idempotency_key: input.idempotency_key },
          nowIso,
        });
        this.store.appendAgentExecutionLog(log);
        return { ok: true, duplicate: true, job: existingJob, log };
      }
    }

    // Resolve sandbox adapter explicitly (default-deny unknown providers).
    const providerId = input.sandbox_provider ?? this.defaultProviderId;
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      const log = this.buildRedactedLog({
        jobId: null,
        taskId,
        agentId,
        requestedAction: input.requested_action,
        permissionDecision: 'deny',
        policyReasonCode: 'UNKNOWN_SANDBOX_PROVIDER',
        approvalId: null,
        outcome: 'denied',
        summary: `Rejected unknown sandbox provider "${providerId}".`,
        details: { sandbox_provider: providerId },
        nowIso,
      });
      this.store.appendAgentExecutionLog(log);
      return {
        ok: false,
        decision: 'deny',
        code: 'UNKNOWN_SANDBOX_PROVIDER',
        error: `Sandbox provider "${providerId}" is not registered.`,
        log,
      };
    }

    // Resolve trusted ApprovalRecord from ApprovalService store ONLY (never trust raw caller-claimed approval if store disagrees, unless explicit Approval object fails closed).
    let approvalRecord: ApprovalRecord | Approval | null = null;
    if (input.approval_id) {
      const stored = this.approvals.getApproval(input.approval_id);
      if (!stored) {
        const log = this.buildRedactedLog({
          jobId: null,
          taskId,
          agentId,
          requestedAction: input.requested_action,
          permissionDecision: 'deny',
          policyReasonCode: 'APPROVAL_NOT_FOUND',
          approvalId: input.approval_id,
          outcome: 'denied',
          summary: `Referenced approval "${input.approval_id}" was not found in ApprovalService store.`,
          details: {},
          nowIso,
        });
        this.store.appendAgentExecutionLog(log);
        return {
          ok: false,
          decision: 'deny',
          code: 'APPROVAL_NOT_FOUND',
          error: `Approval "${input.approval_id}" was not found.`,
          log,
        };
      }
      if (stored.task_id !== taskId) {
        const log = this.buildRedactedLog({
          jobId: null,
          taskId,
          agentId,
          requestedAction: input.requested_action,
          permissionDecision: 'deny',
          policyReasonCode: 'APPROVAL_TASK_MISMATCH',
          approvalId: stored.id,
          outcome: 'denied',
          summary: `Approval "${stored.id}" belongs to task "${stored.task_id}", not "${taskId}".`,
          details: { approval_task_id: stored.task_id },
          nowIso,
        });
        this.store.appendAgentExecutionLog(log);
        return {
          ok: false,
          decision: 'deny',
          code: 'APPROVAL_TASK_MISMATCH',
          error: `Approval "${stored.id}" does not match task "${taskId}".`,
          log,
        };
      }
      approvalRecord = stored;
    } else if (input.approval) {
      // If caller supplied an inline approval record, verify it still matches store if present,
      // or let policy evaluator validate & reject forged/agent-approved/wrong-scope approvals.
      const stored = this.approvals.getApproval(input.approval.id);
      approvalRecord = stored ?? input.approval;
    }

    const validation = validateSandboxExecution({
      input,
      initiator: ctx.initiator,
      policyConfig: this.policyConfig,
      systemConfig: this.systemConfig,
      auditLogger: this.auditLogger,
      correlationId: ctx.correlation_id,
      approvalRecord,
      now,
    });

    if (!validation.allowed) {
      if (validation.decision === 'require_approval') {
        // Create a real Approval Inbox entry if no existing approval ID was passed.
        let pendingApprovalId =
          approvalRecord?.id ?? input.approval_id ?? undefined;
        if (!pendingApprovalId) {
          const actionSpec = POLICY_ACTION_CATALOG[input.requested_action];
          const scopePerm =
            actionSpec?.required_scope ?? input.declared_scopes[0] ?? 'exec:run:sandbox';
          const requesterId =
            ctx.initiator.type === 'owner'
              ? agentId
              : agentId;

          const reqRes = this.approvals.requestApproval({
            task_id: taskId,
            action: input.requested_action,
            requested_by: requesterId,
            environment: input.environment,
            reason: `${input.title}: ${input.description}`,
            scope: {
              resources: [input.resource_id],
              permissions: [scopePerm],
              single_use: true,
              expires_at: new Date(
                now.getTime() + 24 * 60 * 60 * 1000,
              ).toISOString(),
            },
            correlation_id: ctx.correlation_id,
          });

          if (!reqRes.ok) {
            const failLog = this.buildRedactedLog({
              jobId: null,
              taskId,
              agentId,
              requestedAction: input.requested_action,
              permissionDecision: 'deny',
              policyReasonCode: reqRes.code,
              approvalId: null,
              outcome: 'denied',
              summary: reqRes.error,
              details: {},
              nowIso,
            });
            this.store.appendAgentExecutionLog(failLog);
            return {
              ok: false,
              decision: 'deny',
              code: reqRes.code,
              error: reqRes.error,
              log: failLog,
            };
          }
          pendingApprovalId = reqRes.record.id;
        }

        const log = this.buildRedactedLog({
          jobId: null,
          taskId,
          agentId,
          requestedAction: input.requested_action,
          permissionDecision: 'require_approval',
          policyReasonCode: validation.reason_code,
          approvalId: pendingApprovalId ?? null,
          outcome: 'approval_required',
          summary: `Execution paused: ${validation.reason}`,
          details: {
            environment: input.environment,
            resource_id: input.resource_id,
          },
          nowIso,
        });
        this.store.appendAgentExecutionLog(log);
        return {
          ok: false,
          decision: 'require_approval',
          code: validation.reason_code,
          error: validation.reason,
          task_id: taskId,
          approval_id: pendingApprovalId,
          log,
        };
      }

      const denyLog = this.buildRedactedLog({
        jobId: null,
        taskId,
        agentId,
        requestedAction: input.requested_action,
        permissionDecision: 'deny',
        policyReasonCode: validation.reason_code,
        approvalId: approvalRecord?.id ?? null,
        outcome: 'denied',
        summary: `Execution denied: ${validation.reason}`,
        details: {
          environment: input.environment,
          resource_id: input.resource_id,
        },
        nowIso,
      });
      this.store.appendAgentExecutionLog(denyLog);
      return {
        ok: false,
        decision: 'deny',
        code: validation.reason_code,
        error: validation.reason,
        log: denyLog,
      };
    }

    // If an approval was required (L3/L4 or elevated tool/egress), atomically verify & consume it via ApprovalService.
    let consumedApprovalId: string | null = null;
    if (approvalRecord) {
      const storedApproval = this.approvals.getApproval(approvalRecord.id);
      if (!storedApproval) {
        const forgeryLog = this.buildRedactedLog({
          jobId: null,
          taskId,
          agentId,
          requestedAction: input.requested_action,
          permissionDecision: 'deny',
          policyReasonCode: 'APPROVAL_NOT_IN_STORE',
          approvalId: approvalRecord.id,
          outcome: 'denied',
          summary: `Rejected unpersisted or forged approval "${approvalRecord.id}".`,
          details: {},
          nowIso,
        });
        this.store.appendAgentExecutionLog(forgeryLog);
        return {
          ok: false,
          decision: 'deny',
          code: 'APPROVAL_NOT_IN_STORE',
          error: `Approval "${approvalRecord.id}" does not exist in ApprovalService store.`,
          log: forgeryLog,
        };
      }

      const actionSpec = POLICY_ACTION_CATALOG[input.requested_action];
      const requiredScope =
        actionSpec?.required_scope ?? input.declared_scopes[0] ?? 'exec:run:sandbox';

      const consumeRes = this.approvals.verifyAndConsumeApproval({
        approval_id: storedApproval.id,
        task_id: taskId,
        action: input.requested_action,
        resource_id: input.resource_id,
        required_scope: requiredScope,
        environment: input.environment,
        actor_id: agentId,
        correlation_id: ctx.correlation_id,
      });

      if (!consumeRes.ok) {
        const consumeFailLog = this.buildRedactedLog({
          jobId: null,
          taskId,
          agentId,
          requestedAction: input.requested_action,
          permissionDecision: 'deny',
          policyReasonCode: consumeRes.code,
          approvalId: storedApproval.id,
          outcome: 'denied',
          summary: consumeRes.error,
          details: {},
          nowIso,
        });
        this.store.appendAgentExecutionLog(consumeFailLog);
        return {
          ok: false,
          decision: 'deny',
          code: consumeRes.code,
          error: consumeRes.error,
          log: consumeFailLog,
        };
      }

      consumedApprovalId = consumeRes.record.id;
    }

    const knownSecrets = this.getKnownSecrets();
    const redactedInputRes = redactSensitiveValue(input.input ?? {}, knownSecrets);

    const jobId = `job_${crypto.randomUUID()}`;
    const timeoutMs = Math.min(
      300_000,
      Math.max(100, Math.round(input.timeout_ms ?? 30_000)),
    );
    const maxRetries = Math.min(5, Math.max(0, Math.round(input.max_retries ?? 0)));

    const jobRecord: AgentExecutionJobRecord = {
      job_id: jobId,
      task_id: taskId,
      attempt_id: input.attempt_id ?? null,
      agent_id: input.agent.id,
      agent_department: input.agent.department,
      agent_role: input.agent.role,
      sandbox_provider: adapter.providerId,
      isolation_level: adapter.isolationLevel,
      status: 'queued',
      requested_action: input.requested_action,
      resource_id: input.resource_id,
      environment: input.environment,
      permission_decision: 'allow',
      policy_reason_code: validation.reason_code,
      approval_id: consumedApprovalId,
      tool_ids: input.tools.map((t) => t.id),
      declared_scopes: [...input.declared_scopes],
      allowed_paths: validation.normalized_allowed_paths,
      network_mode: validation.network_mode,
      network_allowlist: validation.network_allowlist,
      browser_mode: validation.browser_mode,
      input: redactedInputRes.value as Record<string, unknown>,
      idempotency_key: input.idempotency_key?.trim() || null,
      idempotent_action: input.idempotent_action ?? true,
      retry_count: 0,
      max_retries: maxRetries,
      timeout_ms: timeoutMs,
      next_run_at: nowIso,
      result: null,
      error: null,
      created_at: nowIso,
      started_at: null,
      finished_at: null,
      updated_at: nowIso,
    };

    const initialLog = this.buildRedactedLog({
      jobId,
      taskId,
      agentId: input.agent.id,
      requestedAction: input.requested_action,
      permissionDecision: 'allow',
      policyReasonCode: validation.reason_code,
      approvalId: consumedApprovalId,
      outcome: 'queued',
      summary: `Agent execution job "${jobId}" queued in "${adapter.providerId}".`,
      details: {
        sandbox_provider: adapter.providerId,
        isolation_level: adapter.isolationLevel,
        os_isolated: adapter.supportsOsIsolation,
        tool_ids: jobRecord.tool_ids,
        input_secrets_redacted: redactedInputRes.redactedCount > 0,
      },
      nowIso,
      forceSecretsRedacted: redactedInputRes.redactedCount > 0,
    });

    const persisted = this.store.createAgentExecutionJob({
      job: jobRecord,
      initialLog,
    });

    if (!persisted.created) {
      return {
        ok: true,
        duplicate: true,
        job: persisted.job,
        log: initialLog,
      };
    }

    this.inMemoryExecutionInputs.set(persisted.job.job_id, {
      agent: input.agent,
      tools: input.tools,
      browser_allowlist: validation.browser_allowlist,
      correlation_id: ctx.correlation_id,
    });

    this.auditLogger.logEvent({
      actor_type: 'agent',
      actor_id: input.agent.id,
      event_type: 'agent.execution.queued',
      resource_type: 'task',
      resource_id: taskId,
      action: input.requested_action,
      outcome: 'pending',
      correlation_id: ctx.correlation_id,
      approval_id: consumedApprovalId,
      metadata: {
        job_id: persisted.job.job_id,
        sandbox_provider: adapter.providerId,
        isolation_level: adapter.isolationLevel,
      },
    });

    return {
      ok: true,
      duplicate: false,
      job: persisted.job,
      log: initialLog,
    };
  }

  async runJob(
    jobId: string,
    runtimeArtifacts?: {
      agent?: SubmitAgentExecutionInput['agent'];
      tools?: SubmitAgentExecutionInput['tools'];
      correlation_id?: string;
    },
  ): Promise<ExecuteAgentJobOutcome> {
    const claimed = this.store.claimAgentExecutionJob({
      jobId,
      nowIso: this.clock().toISOString(),
    });
    if (!claimed) {
      return { executed: false, job: this.store.getAgentExecutionJob(jobId) };
    }
    return this.executeClaimedJob(claimed, runtimeArtifacts);
  }

  async runNextQueuedJob(runtimeArtifacts?: {
    agent?: SubmitAgentExecutionInput['agent'];
    tools?: SubmitAgentExecutionInput['tools'];
    correlation_id?: string;
  }): Promise<ExecuteAgentJobOutcome> {
    const claimed = this.store.claimAgentExecutionJob({
      nowIso: this.clock().toISOString(),
    });
    if (!claimed) {
      return { executed: false, job: null };
    }
    return this.executeClaimedJob(claimed, runtimeArtifacts);
  }

  private async executeClaimedJob(
    job: AgentExecutionJobRecord,
    runtimeArtifacts?: {
      agent?: SubmitAgentExecutionInput['agent'];
      tools?: SubmitAgentExecutionInput['tools'];
      correlation_id?: string;
    },
  ): Promise<ExecuteAgentJobOutcome> {
    const adapter = this.adapters.get(job.sandbox_provider);
    if (!adapter) {
      const nowIso = this.clock().toISOString();
      const errObj: AgentExecutionError = {
        code: 'UNKNOWN_SANDBOX_PROVIDER',
        message: `Sandbox adapter "${job.sandbox_provider}" is not registered.`,
        retryable: false,
      };
      const log = this.buildRedactedLog({
        jobId: job.job_id,
        taskId: job.task_id,
        agentId: job.agent_id,
        requestedAction: job.requested_action,
        permissionDecision: job.permission_decision,
        policyReasonCode: job.policy_reason_code,
        approvalId: job.approval_id,
        outcome: 'failed',
        summary: errObj.message,
        details: { error_code: errObj.code },
        nowIso,
      });
      const updated = this.store.completeAgentExecutionJob({
        jobId: job.job_id,
        status: 'failed',
        nowIso,
        error: errObj,
        log,
      });
      return { executed: true, job: updated, log };
    }

    const cached = this.inMemoryExecutionInputs.get(job.job_id);
    const agent = runtimeArtifacts?.agent ??
      cached?.agent ?? {
        id: job.agent_id,
        name: job.agent_id,
        department: job.agent_department,
        role: job.agent_role,
        description: 'Rehydrated agent execution context',
        status: 'active',
        enabled: true,
        permitted_autonomy_level: 'L2',
        allowed_tool_ids: job.tool_ids,
        preferred_model_ids: [],
        created_at: job.created_at,
      };
    const tools = runtimeArtifacts?.tools ??
      cached?.tools ??
      job.tool_ids.map((id, idx) => ({
        id,
        name: id,
        description: 'Rehydrated tool descriptor',
        category: 'utility' as const,
        input_schema_ref: 'contracts/schemas/task.schema.json',
        output_schema_ref: 'contracts/schemas/task.schema.json',
        permission_scope: job.declared_scopes[idx] ?? job.declared_scopes[0] ?? 'exec:run:sandbox',
        risk_level: 'low' as const,
        enabled: true,
      }));
    const correlationId =
      runtimeArtifacts?.correlation_id ??
      cached?.correlation_id ??
      `corr_job_${job.job_id}`;

    const runningLog = this.buildRedactedLog({
      jobId: job.job_id,
      taskId: job.task_id,
      agentId: job.agent_id,
      requestedAction: job.requested_action,
      permissionDecision: job.permission_decision,
      policyReasonCode: job.policy_reason_code,
      approvalId: job.approval_id,
      outcome: 'running',
      summary: `Started sandboxed execution in "${adapter.providerId}" (retry ${job.retry_count}/${job.max_retries}).`,
      details: {
        sandbox_provider: adapter.providerId,
        isolation_level: adapter.isolationLevel,
        os_isolated: adapter.supportsOsIsolation,
      },
      nowIso: this.clock().toISOString(),
    });
    this.store.appendAgentExecutionLog(runningLog);

    const controller = new AbortController();
    this.activeControllers.set(job.job_id, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new Error(`Sandbox execution timed out after ${job.timeout_ms}ms.`),
      );
    }, job.timeout_ms);

    let outcome;
    try {
      outcome = await adapter.execute(
        {
          job,
          agent,
          tools,
          workspace_root: this.policyConfig.workspaceRoot,
          allowed_paths: job.allowed_paths,
          network_mode: job.network_mode,
          network_allowlist: job.network_allowlist,
          browser_mode: job.browser_mode,
          browser_allowlist: cached?.browser_allowlist ?? [],
          correlation_id: correlationId,
        },
        controller.signal,
      );
    } catch (err) {
      outcome = {
        ok: false as const,
        error: {
          code: timedOut ? 'EXECUTION_TIMEOUT' : 'SANDBOX_UNHANDLED_ERROR',
          message:
            err instanceof Error
              ? err.message
              : 'Unhandled sandbox execution exception.',
          retryable: !timedOut,
        },
      };
    } finally {
      clearTimeout(timer);
      this.activeControllers.delete(job.job_id);
    }

    const finishNow = this.clock();
    const finishIso = finishNow.toISOString();
    const latestPersisted = this.store.getAgentExecutionJob(job.job_id);

    if (latestPersisted?.status === 'cancelled') {
      const cancelLog = this.buildRedactedLog({
        jobId: job.job_id,
        taskId: job.task_id,
        agentId: job.agent_id,
        requestedAction: job.requested_action,
        permissionDecision: job.permission_decision,
        policyReasonCode: job.policy_reason_code,
        approvalId: job.approval_id,
        outcome: 'cancelled',
        summary: 'Execution terminated because job was cancelled by owner.',
        details: {},
        nowIso: finishIso,
      });
      this.store.appendAgentExecutionLog(cancelLog);
      return { executed: true, job: latestPersisted, log: cancelLog };
    }

    const knownSecrets = this.getKnownSecrets();

    if (outcome.ok) {
      const redactedResult = redactSensitiveValue(outcome.result, knownSecrets);
      const completedLog = this.buildRedactedLog({
        jobId: job.job_id,
        taskId: job.task_id,
        agentId: job.agent_id,
        requestedAction: job.requested_action,
        permissionDecision: job.permission_decision,
        policyReasonCode: job.policy_reason_code,
        approvalId: job.approval_id,
        outcome: 'completed',
        summary: `Sandbox job "${job.job_id}" completed successfully.`,
        details: {
          sandbox_provider: job.sandbox_provider,
          result: redactedResult.value,
        },
        nowIso: finishIso,
        forceSecretsRedacted:
          outcome.secrets_redacted === true || redactedResult.redactedCount > 0,
      });

      const updated = this.store.completeAgentExecutionJob({
        jobId: job.job_id,
        status: 'completed',
        nowIso: finishIso,
        result: redactedResult.value as Record<string, unknown>,
        error: null,
        log: completedLog,
      });

      this.auditLogger.logEvent({
        actor_type: 'agent',
        actor_id: job.agent_id,
        event_type: 'agent.execution.completed',
        resource_type: 'task',
        resource_id: job.task_id,
        action: job.requested_action,
        outcome: 'success',
        correlation_id: correlationId,
        approval_id: job.approval_id,
        metadata: {
          job_id: job.job_id,
          sandbox_provider: job.sandbox_provider,
        },
      });

      return { executed: true, job: updated, log: completedLog };
    }

    const redactedErrRes = redactAgentError(
      timedOut
        ? {
            code: 'EXECUTION_TIMEOUT',
            message: outcome.error.message,
            retryable: false,
          }
        : outcome.error,
      knownSecrets,
    );
    const redactedErr = redactedErrRes.value;
    const anySecretRedacted =
      outcome.secrets_redacted === true || redactedErrRes.redactedCount > 0;

    const canRetry =
      !timedOut &&
      redactedErr.retryable &&
      job.idempotent_action &&
      job.retry_count < job.max_retries;

    if (canRetry) {
      const nextRetry = job.retry_count + 1;
      const retryLog = this.buildRedactedLog({
        jobId: job.job_id,
        taskId: job.task_id,
        agentId: job.agent_id,
        requestedAction: job.requested_action,
        permissionDecision: job.permission_decision,
        policyReasonCode: job.policy_reason_code,
        approvalId: job.approval_id,
        outcome: 'queued',
        summary: `Sandbox job "${job.job_id}" failed (${redactedErr.code}); re-queued for retry ${nextRetry}/${job.max_retries}.`,
        details: {
          error: redactedErr,
          retry_count: nextRetry,
          max_retries: job.max_retries,
        },
        nowIso: finishIso,
        forceSecretsRedacted: anySecretRedacted,
      });

      const updated = this.store.completeAgentExecutionJob({
        jobId: job.job_id,
        status: 'queued',
        nowIso: finishIso,
        error: redactedErr,
        retryCount: nextRetry,
        nextRunAt: finishIso,
        log: retryLog,
      });

      return { executed: true, job: updated, log: retryLog, retried: true };
    }

    const failedLog = this.buildRedactedLog({
      jobId: job.job_id,
      taskId: job.task_id,
      agentId: job.agent_id,
      requestedAction: job.requested_action,
      permissionDecision: job.permission_decision,
      policyReasonCode: job.policy_reason_code,
      approvalId: job.approval_id,
      outcome: 'failed',
      summary: `Sandbox job "${job.job_id}" failed (${redactedErr.code}): ${redactedErr.message}`,
      details: {
        error: redactedErr,
        retry_count: job.retry_count,
        max_retries: job.max_retries,
      },
      nowIso: finishIso,
      forceSecretsRedacted: anySecretRedacted,
    });

    const updated = this.store.completeAgentExecutionJob({
      jobId: job.job_id,
      status: 'failed',
      nowIso: finishIso,
      error: redactedErr,
      log: failedLog,
    });

    this.auditLogger.logFailure({
      actor_type: 'agent',
      actor_id: job.agent_id,
      resource_type: 'task',
      resource_id: job.task_id,
      action: job.requested_action,
      error_code: redactedErr.code,
      correlation_id: correlationId,
      approval_id: job.approval_id,
      metadata: {
        job_id: job.job_id,
        error_message: redactedErr.message,
      },
    });

    return { executed: true, job: updated, log: failedLog, retried: false };
  }

  cancelJob(params: {
    jobId: string;
    actor: PolicyActor;
    reason: string;
    correlation_id: string;
  }):
    | { ok: true; job: AgentExecutionJobRecord }
    | { ok: false; code: string; error: string } {
    if (
      params.actor.type !== 'owner' ||
      params.actor.trusted_authenticated !== true
    ) {
      return {
        ok: false,
        code: 'OWNER_AUTHENTICATION_REQUIRED',
        error: 'Only the authenticated human owner may cancel agent execution jobs.',
      };
    }

    const existing = this.store.getAgentExecutionJob(params.jobId);
    if (!existing) {
      return {
        ok: false,
        code: 'JOB_NOT_FOUND',
        error: `Execution job "${params.jobId}" was not found.`,
      };
    }

    if (['completed', 'failed', 'cancelled'].includes(existing.status)) {
      return {
        ok: false,
        code: 'JOB_ALREADY_TERMINAL',
        error: `Execution job "${existing.job_id}" is already "${existing.status}".`,
      };
    }

    const activeController = this.activeControllers.get(existing.job_id);
    if (activeController) {
      activeController.abort(new Error(params.reason || 'Cancelled by owner.'));
    }

    const nowIso = this.clock().toISOString();
    const cancelReason = params.reason || 'Cancelled by human owner.';
    const errorObj: AgentExecutionError = {
      code: 'CANCELLED_BY_OWNER',
      message: cancelReason,
      retryable: false,
    };

    const log = this.buildRedactedLog({
      jobId: existing.job_id,
      taskId: existing.task_id,
      agentId: existing.agent_id,
      requestedAction: existing.requested_action,
      permissionDecision: existing.permission_decision,
      policyReasonCode: existing.policy_reason_code,
      approvalId: existing.approval_id,
      outcome: 'cancelled',
      summary: `Job "${existing.job_id}" cancelled by owner: ${cancelReason}`,
      details: { cancelled_by: params.actor.id },
      nowIso,
    });

    const updated = this.store.cancelAgentExecutionJob({
      jobId: existing.job_id,
      nowIso,
      error: errorObj,
      log,
    })!;

    this.auditLogger.logEvent({
      actor_type: 'owner',
      actor_id: params.actor.id,
      event_type: 'agent.execution.cancelled',
      resource_type: 'task',
      resource_id: existing.task_id,
      action: existing.requested_action,
      outcome: 'cancelled',
      correlation_id: params.correlation_id,
      approval_id: existing.approval_id,
      metadata: { job_id: existing.job_id },
    });

    return { ok: true, job: updated };
  }

  getJob(jobId: string): AgentExecutionJobRecord | null {
    return this.store.getAgentExecutionJob(jobId);
  }

  listJobs(filter?: {
    status?: AgentExecutionJobStatus;
    taskId?: string;
    agentId?: string;
    limit?: number;
  }): AgentExecutionJobRecord[] {
    return this.store.listAgentExecutionJobs(filter);
  }

  listExecutionLogs(filter?: {
    jobId?: string;
    taskId?: string;
    agentId?: string;
    limit?: number;
  }): AgentExecutionLogRecord[] {
    return this.store.listAgentExecutionLogs(filter);
  }
}
