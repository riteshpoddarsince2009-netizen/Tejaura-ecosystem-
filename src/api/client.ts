import type {
  ApprovalItem,
  AuditLogItem,
  AuthStatusResponse,
  AutonomyLevel,
  ComputeNodeItem,
  ExecutionAttempt,
  ExecutionEnvironment,
  ModelInventoryItem,
  OrchestratedTask,
  ScheduleItem,
  SystemOverviewResponse,
  TaskEvent,
  TaskStatus,
} from '../types/controlPlane.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly mfaRequired?: boolean;

  constructor(status: number, code: string, message: string, mfaRequired?: boolean) {
    super(message);
    this.status = status;
    this.code = code;
    this.mfaRequired = mfaRequired;
  }
}

async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
  } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-TEJAURA-CSRF'] = '1';
  }

  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.ok === false) {
    throw new ApiError(
      res.status,
      typeof data.code === 'string' ? data.code : 'REQUEST_FAILED',
      typeof data.error === 'string'
        ? data.error
        : `Control plane request failed with HTTP ${res.status}.`,
      data.mfa_required === true,
    );
  }

  return data as T;
}

export const controlPlaneApi = {
  getAuthStatus(): Promise<AuthStatusResponse> {
    return apiRequest('/api/auth/status');
  },

  setupOwner(input: {
    owner_id: string;
    username: string;
    email: string;
    password: string;
  }): Promise<{
    ok: true;
    owner_id: string;
    username: string;
    recovery_codes: string[];
  }> {
    return apiRequest('/api/auth/setup', { method: 'POST', body: input });
  },

  login(input: {
    identifier: string;
    password: string;
    mfa_code?: string;
  }): Promise<{ ok: true; owner: SystemOverviewResponse['owner'] }> {
    return apiRequest('/api/auth/login', { method: 'POST', body: input });
  },

  logout(): Promise<{ ok: true }> {
    return apiRequest('/api/auth/logout', { method: 'POST', body: {} });
  },

  recoverAccount(input: {
    identifier: string;
    recovery_code: string;
    new_password: string;
  }): Promise<{
    ok: true;
    owner_id: string;
    revoked_sessions: number;
    remaining_recovery_codes: number;
  }> {
    return apiRequest('/api/auth/recover', { method: 'POST', body: input });
  },

  enrollMfa(label: string): Promise<{
    ok: true;
    factor_id: string;
    type: 'totp';
    otpauth_uri?: string;
    provisioning_secret?: string;
  }> {
    return apiRequest('/api/auth/mfa/enroll', {
      method: 'POST',
      body: { label },
    });
  },

  revokeAllSessions(): Promise<{ ok: true; revoked_count: number }> {
    return apiRequest('/api/auth/sessions/revoke-all', {
      method: 'POST',
      body: {},
    });
  },

  getOverview(): Promise<SystemOverviewResponse> {
    return apiRequest('/api/system/overview');
  },

  listTasks(status?: TaskStatus): Promise<{ ok: true; tasks: OrchestratedTask[] }> {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return apiRequest(`/api/tasks${q}`);
  },

  getTaskDetail(taskId: string): Promise<{
    ok: true;
    task: OrchestratedTask;
    events: TaskEvent[];
    attempts: ExecutionAttempt[];
  }> {
    return apiRequest(`/api/tasks/${encodeURIComponent(taskId)}`);
  },

  createTask(input: {
    title: string;
    description: string;
    action: string;
    resource_id: string;
    environment: ExecutionEnvironment;
    autonomy_level: AutonomyLevel;
    declared_scopes: string[];
    priority: number;
    idempotency_key?: string;
    idempotent_action: boolean;
    max_retries: number;
    timeout_ms: number;
    input: Record<string, unknown>;
    owner_confirmed_l4?: boolean;
  }): Promise<{
    ok: true;
    duplicate: boolean;
    task: OrchestratedTask;
    approval_id?: string;
  }> {
    return apiRequest('/api/tasks', { method: 'POST', body: input });
  },

  cancelTask(taskId: string, reason: string): Promise<{ ok: true; task: OrchestratedTask }> {
    return apiRequest(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      body: { reason },
    });
  },

  retryTask(
    taskId: string,
    confirmNonIdempotentRetry: boolean,
  ): Promise<{ ok: true; task: OrchestratedTask }> {
    return apiRequest(`/api/tasks/${encodeURIComponent(taskId)}/retry`, {
      method: 'POST',
      body: { confirm_non_idempotent_retry: confirmNonIdempotentRetry },
    });
  },

  listSchedules(): Promise<{ ok: true; schedules: ScheduleItem[] }> {
    return apiRequest('/api/schedules');
  },

  createSchedule(input: {
    name: string;
    description: string;
    interval_seconds: number;
    task_template: ScheduleItem['task_template'];
  }): Promise<{ ok: true; schedule: ScheduleItem }> {
    return apiRequest('/api/schedules', { method: 'POST', body: input });
  },

  toggleSchedule(
    scheduleId: string,
    enabled: boolean,
  ): Promise<{ ok: true; schedule: ScheduleItem }> {
    return apiRequest(`/api/schedules/${encodeURIComponent(scheduleId)}/toggle`, {
      method: 'POST',
      body: { enabled },
    });
  },

  listApprovals(): Promise<{ ok: true; approvals: ApprovalItem[] }> {
    return apiRequest('/api/approvals');
  },

  decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason: string,
  ): Promise<{
    ok: true;
    approval: ApprovalItem;
    task: OrchestratedTask | null;
  }> {
    return apiRequest(`/api/approvals/${encodeURIComponent(approvalId)}/decide`, {
      method: 'POST',
      body: { decision, reason },
    });
  },

  listModels(): Promise<{
    ok: true;
    primary_runtime: string;
    models: ModelInventoryItem[];
    compute_nodes: ComputeNodeItem[];
    trusted_endpoints: SystemOverviewResponse['trusted_endpoints'];
  }> {
    return apiRequest('/api/models');
  },

  probeModel(modelId: string): Promise<{
    ok: true;
    probe: {
      available: boolean;
      status: string;
      code: string;
      reason: string;
    };
  }> {
    return apiRequest(`/api/models/${encodeURIComponent(modelId)}/probe`, {
      method: 'POST',
      body: {},
    });
  },

  runWorkerTick(): Promise<{
    ok: true;
    report: {
      recovered_abandoned: number;
      schedules_triggered: number;
      task_executed: boolean;
      executed_task_id?: string;
      executed_status?: string;
    };
  }> {
    return apiRequest('/api/worker/tick', { method: 'POST', body: {} });
  },

  listAuditEvents(): Promise<{ ok: true; events: AuditLogItem[] }> {
    return apiRequest('/api/audit');
  },
};
