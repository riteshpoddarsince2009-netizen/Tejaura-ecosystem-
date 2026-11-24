import type {
  ActiveSessionInfo,
  AgentDepartment,
  AgentExecutionJobItem,
  AgentExecutionLogItem,
  AgentStatus,
  ApprovalItem,
  AuditLogItem,
  AuthStatusResponse,
  AutonomyLevel,
  ComputeNodeItem,
  ExecutionAttempt,
  ExecutionEnvironment,
  ManagedAgentItem,
  ManagedProjectItem,
  ManagedProjectType,
  ManagedWorkerItem,
  MfaFactorInfo,
  ModelInventoryItem,
  ModelSource,
  OrchestratedTask,
  OwnerProfileInfo,
  ScheduleItem,
  SystemAdminOverview,
  SystemBackupItem,
  SystemConfigSettings,
  SystemOverviewResponse,
  TaskEvent,
  TaskStatus,
  UnifiedLogEntry,
} from '../types/controlPlane.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly mfaRequired?: boolean;
  readonly approvalId?: string;
  readonly requiresApproval?: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    mfaRequired?: boolean,
    approvalId?: string,
    requiresApproval?: boolean,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.mfaRequired = mfaRequired;
    this.approvalId = approvalId;
    this.requiresApproval = requiresApproval;
  }
}

async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
    const approval = data.approval as { id?: unknown } | undefined;
    throw new ApiError(
      res.status,
      typeof data.code === 'string' ? data.code : 'REQUEST_FAILED',
      typeof data.error === 'string'
        ? data.error
        : `Control plane request failed with HTTP ${res.status}.`,
      data.mfa_required === true,
      typeof approval?.id === 'string' ? approval.id : undefined,
      data.requires_approval === true,
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

  // -------------------- Stage 4.5 Profile, Sessions & MFA --------------------

  getProfile(): Promise<{ ok: true; profile: OwnerProfileInfo }> {
    return apiRequest('/api/auth/profile');
  },

  updateProfile(input: {
    display_name?: string;
    email?: string;
    timezone?: string;
  }): Promise<{ ok: true; profile: OwnerProfileInfo }> {
    return apiRequest('/api/auth/profile', { method: 'PATCH', body: input });
  },

  changePassword(input: {
    current_password: string;
    new_password: string;
  }): Promise<{ ok: true; revoked_other_sessions: number; password_changed_at: string }> {
    return apiRequest('/api/auth/password', { method: 'POST', body: input });
  },

  listSessions(includeRevoked = false): Promise<{
    ok: true;
    sessions: ActiveSessionInfo[];
  }> {
    return apiRequest(`/api/auth/sessions${includeRevoked ? '?include_revoked=true' : ''}`);
  },

  revokeSession(sessionId: string): Promise<{ ok: true; revoked_current: boolean }> {
    return apiRequest(`/api/auth/sessions/${encodeURIComponent(sessionId)}/revoke`, {
      method: 'POST',
      body: {},
    });
  },

  revokeOtherSessions(): Promise<{ ok: true; revoked_count: number }> {
    return apiRequest('/api/auth/sessions/revoke-others', {
      method: 'POST',
      body: {},
    });
  },

  listMfaFactors(): Promise<{
    ok: true;
    factors: MfaFactorInfo[];
    recovery_codes_remaining: number;
  }> {
    return apiRequest('/api/auth/mfa');
  },

  toggleMfaFactor(
    factorId: string,
    enabled: boolean,
    currentPassword: string,
  ): Promise<{ ok: true; factor: MfaFactorInfo }> {
    return apiRequest(`/api/auth/mfa/${encodeURIComponent(factorId)}/toggle`, {
      method: 'POST',
      body: { enabled, current_password: currentPassword },
    });
  },

  removeMfaFactor(
    factorId: string,
    currentPassword: string,
  ): Promise<{ ok: true; factor_id: string }> {
    return apiRequest(`/api/auth/mfa/${encodeURIComponent(factorId)}`, {
      method: 'DELETE',
      body: { current_password: currentPassword },
    });
  },

  regenerateRecoveryCodes(currentPassword: string): Promise<{
    ok: true;
    recovery_codes: string[];
  }> {
    return apiRequest('/api/auth/recovery-codes/regenerate', {
      method: 'POST',
      body: { current_password: currentPassword },
    });
  },

  // -------------------- Stage 4.5 Agent Management --------------------

  listAgents(filter?: {
    department?: AgentDepartment | 'all';
    status?: AgentStatus | 'all';
    limit?: number;
    offset?: number;
  }): Promise<{
    ok: true;
    agents: ManagedAgentItem[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const params = new URLSearchParams();
    if (filter?.department && filter.department !== 'all') {
      params.set('department', filter.department);
    }
    if (filter?.status && filter.status !== 'all') {
      params.set('status', filter.status);
    }
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));
    const q = params.toString();
    return apiRequest(`/api/agents${q ? `?${q}` : ''}`);
  },

  createAgent(input: {
    id?: string;
    name: string;
    department: AgentDepartment;
    role: string;
    description: string;
    permitted_autonomy_level: 'L0' | 'L1' | 'L2' | 'L3';
    allowed_tool_ids: string[];
    preferred_model_ids: string[];
    backup_model_ids: string[];
    max_concurrent_jobs: number;
    timeout_ms: number;
    allowed_paths: string[];
    network_mode: 'none' | 'allowlisted_endpoints';
  }): Promise<{ ok: true; agent: ManagedAgentItem }> {
    return apiRequest('/api/agents', { method: 'POST', body: input });
  },

  updateAgent(
    agentId: string,
    input: Partial<Omit<ManagedAgentItem, 'id' | 'created_at' | 'updated_at'>>,
  ): Promise<{ ok: true; agent: ManagedAgentItem }> {
    return apiRequest(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      body: input,
    });
  },

  setAgentStatus(
    agentId: string,
    status: AgentStatus,
    enabled: boolean,
  ): Promise<{ ok: true; agent: ManagedAgentItem }> {
    return apiRequest(`/api/agents/${encodeURIComponent(agentId)}/status`, {
      method: 'POST',
      body: { status, enabled },
    });
  },

  getAgentHistory(agentId: string): Promise<{
    ok: true;
    agent: ManagedAgentItem;
    jobs: AgentExecutionJobItem[];
    logs: AgentExecutionLogItem[];
  }> {
    return apiRequest(`/api/agents/${encodeURIComponent(agentId)}/history`);
  },

  // -------------------- Stage 4.5 Model Management --------------------

  createModel(input: {
    model_id: string;
    model_name: string;
    model_family: string;
    model_version: string;
    source: ModelSource;
    repo_id: string;
    revision?: string;
    runtime_type: string;
    format?: string;
    size_mb?: number;
    quantization?: string;
    context_length?: number;
    compatibility_status?: 'verified' | 'untested' | 'unsupported';
    local_model_path?: string | null;
    controlled_runtime_endpoint?: string | null;
    enabled?: boolean;
  }): Promise<{ ok: true; model: ModelInventoryItem }> {
    return apiRequest('/api/models', { method: 'POST', body: input });
  },

  toggleModel(
    modelId: string,
    enabled: boolean,
  ): Promise<{ ok: true; model: ModelInventoryItem }> {
    return apiRequest(`/api/models/${encodeURIComponent(modelId)}/toggle`, {
      method: 'POST',
      body: { enabled },
    });
  },

  setModelRole(
    modelId: string,
    role: 'default' | 'backup',
  ): Promise<{ ok: true; model: ModelInventoryItem }> {
    return apiRequest(`/api/models/${encodeURIComponent(modelId)}/role`, {
      method: 'POST',
      body: { role },
    });
  },

  verifyModelInstall(modelId: string): Promise<{
    ok: true;
    model: ModelInventoryItem;
  }> {
    return apiRequest(`/api/models/${encodeURIComponent(modelId)}/verify-install`, {
      method: 'POST',
      body: {},
    });
  },

  deleteModel(modelId: string): Promise<{ ok: true; model_id: string }> {
    return apiRequest(`/api/models/${encodeURIComponent(modelId)}`, {
      method: 'DELETE',
    });
  },

  // -------------------- Stage 4.5 Worker & Compute Management --------------------

  listWorkers(limit = 50, offset = 0): Promise<{
    ok: true;
    workers: ManagedWorkerItem[];
    total: number;
  }> {
    return apiRequest(`/api/workers?limit=${limit}&offset=${offset}`);
  },

  createWorker(input: {
    worker_id?: string;
    name: string;
    runtime_type: string;
    node_id: string;
    base_url: string;
    requires_auth?: boolean;
    auth_token_env_var?: string | null;
    enabled?: boolean;
    approval_id?: string;
  }): Promise<{ ok: true; worker: ManagedWorkerItem }> {
    return apiRequest('/api/workers', { method: 'POST', body: input });
  },

  toggleWorker(
    workerId: string,
    enabled: boolean,
    approvalId?: string,
  ): Promise<{ ok: true; worker: ManagedWorkerItem }> {
    return apiRequest(`/api/workers/${encodeURIComponent(workerId)}/toggle`, {
      method: 'POST',
      body: { enabled, ...(approvalId ? { approval_id: approvalId } : {}) },
    });
  },

  probeWorker(workerId: string): Promise<{ ok: true; worker: ManagedWorkerItem }> {
    return apiRequest(`/api/workers/${encodeURIComponent(workerId)}/probe`, {
      method: 'POST',
      body: {},
    });
  },

  deleteWorker(
    workerId: string,
    approvalId?: string,
  ): Promise<{ ok: true; worker_id: string }> {
    const query = approvalId
      ? `?approval_id=${encodeURIComponent(approvalId)}`
      : '';
    return apiRequest(
      `/api/workers/${encodeURIComponent(workerId)}${query}`,
      { method: 'DELETE' },
    );
  },

  // -------------------- Stage 4.5 Project & Website Management --------------------

  listProjects(filter?: {
    environment?: ExecutionEnvironment | 'all';
    limit?: number;
    offset?: number;
  }): Promise<{
    ok: true;
    projects: ManagedProjectItem[];
    total: number;
  }> {
    const params = new URLSearchParams();
    if (filter?.environment && filter.environment !== 'all') {
      params.set('environment', filter.environment);
    }
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));
    const q = params.toString();
    return apiRequest(`/api/projects${q ? `?${q}` : ''}`);
  },

  createProject(input: {
    name: string;
    slug?: string;
    project_type: ManagedProjectType;
    description?: string;
    domain_url?: string | null;
    workspace_path?: string;
    environment: ExecutionEnvironment;
    assigned_agent_ids: string[];
  }): Promise<{ ok: true; project: ManagedProjectItem }> {
    return apiRequest('/api/projects', { method: 'POST', body: input });
  },

  updateProject(
    projectId: string,
    input: Partial<{
      name: string;
      slug: string;
      project_type: ManagedProjectType;
      description: string;
      domain_url: string | null;
      workspace_path: string;
      environment: ExecutionEnvironment;
      assigned_agent_ids: string[];
    }>,
  ): Promise<{ ok: true; project: ManagedProjectItem }> {
    return apiRequest(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: input,
    });
  },

  deployProject(
    projectId: string,
    input: {
      target_environment?: ExecutionEnvironment;
      notes?: string;
      },
  ): Promise<{
    ok: true;
    project: ManagedProjectItem;
    requires_approval: boolean;
    approval?: ApprovalItem;
  }> {
    return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/deploy`, {
      method: 'POST',
      body: input,
    });
  },

  deleteProject(projectId: string): Promise<{ ok: true; project_id: string }> {
    return apiRequest(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    });
  },

  // -------------------- Stage 4.5 System Administration --------------------

  getSystemAdmin(): Promise<{ ok: true; admin: SystemAdminOverview }> {
    return apiRequest('/api/system/admin');
  },

  updateSystemConfig(input: Partial<SystemConfigSettings>): Promise<{
    ok: true;
    config: SystemConfigSettings;
  }> {
    return apiRequest('/api/system/config', { method: 'PATCH', body: input });
  },

  listSystemLogs(filter?: {
    source?: 'all' | 'audit' | 'task_event' | 'agent_execution';
    severity?: 'all' | 'info' | 'warn' | 'error';
    limit?: number;
    offset?: number;
  }): Promise<{
    ok: true;
    logs: UnifiedLogEntry[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const params = new URLSearchParams();
    if (filter?.source) params.set('source', filter.source);
    if (filter?.severity) params.set('severity', filter.severity);
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));
    const q = params.toString();
    return apiRequest(`/api/system/logs${q ? `?${q}` : ''}`);
  },

  createBackup(): Promise<{ ok: true; backup: SystemBackupItem }> {
    return apiRequest('/api/system/backups', { method: 'POST', body: {} });
  },

  restoreBackup(backupId: string): Promise<{ ok: true; backup: SystemBackupItem }> {
    return apiRequest(`/api/system/backups/${encodeURIComponent(backupId)}/restore`, {
      method: 'POST',
      body: {},
    });
  },
};
