import type {
  AutonomyLevel,
  ExecutionEnvironment,
  Task,
  TaskError,
  TaskStatus,
} from '../../contracts/types/index.ts';
import type { ApprovalRecord, ApprovalStore } from '../../core/approvals/index.ts';
import type { AppliedMigrationRecord } from './migrations.ts';

export interface OrchestratedTaskRecord extends Task {
  environment: ExecutionEnvironment;
  action: string;
  resource_id: string;
  declared_scopes: string[];
  priority: number;
  idempotency_key: string | null;
  idempotent_action: boolean;
  deadline_at: string | null;
  retry_count: number;
  max_retries: number;
  timeout_ms: number;
  next_run_at: string;
  schedule_id: string | null;
}

export interface TaskEventRecord {
  event_id: string;
  task_id: string;
  event_type: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  actor_id: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export type ExecutionAttemptStatus =
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'abandoned'
  | 'cancelled';

export interface ExecutionAttemptRecord {
  attempt_id: string;
  task_id: string;
  attempt_number: number;
  worker_id: string;
  lease_token: string;
  lease_expires_at: string;
  status: ExecutionAttemptStatus;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  runtime_type: string | null;
  model_id: string | null;
  external_effect_dispatched: boolean;
}

export interface ScheduleTaskTemplate {
  type: string;
  title: string;
  description: string;
  action: string;
  resource_id: string;
  environment: ExecutionEnvironment;
  autonomy_level: AutonomyLevel;
  declared_scopes: string[];
  priority: number;
  idempotent_action: boolean;
  max_retries: number;
  timeout_ms: number;
  input: Record<string, unknown>;
}

export interface ScheduleRecord {
  id: string;
  name: string;
  description: string;
  interval_seconds: number;
  next_run_at: string;
  enabled: boolean;
  task_template: ScheduleTaskTemplate;
  last_task_id: string | null;
  last_run_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface LeasedTaskAttempt {
  task: OrchestratedTaskRecord;
  attempt: ExecutionAttemptRecord;
}

export interface LeaseRecoveryReport {
  recovered_count: number;
  requeued_task_ids: string[];
  failed_task_ids: string[];
}

export interface CreateTaskPersistenceInput {
  task: OrchestratedTaskRecord;
  initialEvent: TaskEventRecord;
}

export type AgentExecutionJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type SandboxIsolationLevel = 'mock_in_process' | 'isolated_container';
export type SandboxNetworkMode = 'none' | 'allowlisted_endpoints';
export type SandboxBrowserMode = 'disabled' | 'read_only_allowlisted';
export type AgentPermissionDecision = 'allow' | 'deny' | 'require_approval';

export interface AgentExecutionError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface AgentExecutionJobRecord {
  job_id: string;
  task_id: string;
  attempt_id: string | null;
  agent_id: string;
  agent_department: string;
  agent_role: string;
  sandbox_provider: string;
  isolation_level: SandboxIsolationLevel;
  status: AgentExecutionJobStatus;
  requested_action: string;
  resource_id: string;
  environment: ExecutionEnvironment;
  permission_decision: AgentPermissionDecision;
  policy_reason_code: string;
  approval_id: string | null;
  tool_ids: string[];
  declared_scopes: string[];
  allowed_paths: string[];
  network_mode: SandboxNetworkMode;
  network_allowlist: string[];
  browser_mode: SandboxBrowserMode;
  input: Record<string, unknown>;
  idempotency_key: string | null;
  idempotent_action: boolean;
  retry_count: number;
  max_retries: number;
  timeout_ms: number;
  next_run_at: string;
  result: Record<string, unknown> | null;
  error: AgentExecutionError | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export type AgentExecutionLogOutcome =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'denied'
  | 'approval_required';

export interface AgentExecutionLogRecord {
  log_id: string;
  job_id: string | null;
  task_id: string;
  agent_id: string;
  requested_action: string;
  permission_decision: AgentPermissionDecision;
  policy_reason_code: string;
  approval_id: string | null;
  outcome: AgentExecutionLogOutcome;
  summary: string;
  details: Record<string, unknown>;
  secrets_redacted: boolean;
  created_at: string;
}

export interface AgentExecutionRecoveryReport {
  recovered_count: number;
  requeued_job_ids: string[];
  failed_job_ids: string[];
}

export type ManagedAgentDepartment =
  | 'research'
  | 'engineering'
  | 'seo'
  | 'design'
  | 'content'
  | 'analytics'
  | 'customer_support';

export type ManagedAgentStatus = 'active' | 'paused' | 'disabled' | 'retired';
export type ManagedAgentHealth = 'healthy' | 'degraded' | 'offline' | 'unknown';

export interface ManagedAgentRecord {
  id: string;
  name: string;
  department: ManagedAgentDepartment;
  role: string;
  description: string;
  status: ManagedAgentStatus;
  enabled: boolean;
  permitted_autonomy_level: 'L0' | 'L1' | 'L2' | 'L3';
  allowed_tool_ids: string[];
  preferred_model_ids: string[];
  backup_model_ids: string[];
  max_concurrent_jobs: number;
  timeout_ms: number;
  allowed_paths: string[];
  network_mode: SandboxNetworkMode;
  last_health_status: ManagedAgentHealth;
  created_by: string;
  created_at: string;
  updated_at: string;
  schema_version: string;
}

export type ManagedModelSource =
  | 'modelscope'
  | 'huggingface'
  | 'local_mirror'
  | 'owner_archive';

export type ModelInstallStatus =
  | 'not_installed'
  | 'downloading'
  | 'installed_unverified'
  | 'verified'
  | 'error';

export interface ManagedModelRecord {
  model_id: string;
  model_name: string;
  model_family: string;
  model_version: string;
  source: ManagedModelSource;
  repo_id: string;
  revision: string;
  local_model_path: string | null;
  controlled_runtime_endpoint: string | null;
  runtime_type: string;
  compatibility_status: 'verified' | 'untested' | 'unsupported';
  modality: 'text' | 'code' | 'vision' | 'audio' | 'multimodal';
  capabilities: string[];
  hardware_requirements: {
    min_ram_mb: number;
    min_vram_mb: number;
    min_storage_mb: number;
    requires_gpu: boolean;
    recommended_ram_mb?: number;
    recommended_vram_mb?: number;
  };
  quantization: string;
  context_length: number;
  size_mb: number;
  format: string;
  install_status: ModelInstallStatus;
  verified_on_disk: boolean;
  is_default: boolean;
  is_backup: boolean;
  enabled: boolean;
  availability: string;
  license: {
    name: string;
    spdx_id?: string;
    open_weight: true;
    commercial_use_allowed?: boolean;
    source_url?: string;
  };
  node_id: string | null;
  last_verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type ManagedWorkerHealthStatus =
  | 'online'
  | 'offline'
  | 'degraded'
  | 'unknown';

export interface ManagedWorkerRecord {
  worker_id: string;
  name: string;
  runtime_type: string;
  node_id: string;
  base_url: string;
  requires_auth: boolean;
  auth_token_env_var: string | null;
  enabled: boolean;
  health_status: ManagedWorkerHealthStatus;
  current_model_id: string | null;
  active_jobs: number;
  queue_length: number;
  latency_ms: number | null;
  discovered_models: string[];
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type ManagedProjectType =
  | 'website'
  | 'web_app'
  | 'api_service'
  | 'automation';

export type ManagedProjectDeploymentStatus =
  | 'draft'
  | 'pending_approval'
  | 'deployed'
  | 'degraded'
  | 'failed'
  | 'paused';

export type ManagedProjectHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'offline'
  | 'unknown';

export interface ProjectChangeEntry {
  change_id: string;
  summary: string;
  actor_id: string;
  environment: ExecutionEnvironment;
  created_at: string;
}

export interface ProjectErrorEntry {
  error_id: string;
  code: string;
  message: string;
  created_at: string;
}

export interface ManagedProjectRecord {
  project_id: string;
  name: string;
  slug: string;
  project_type: ManagedProjectType;
  description: string;
  domain_url: string | null;
  workspace_path: string;
  environment: ExecutionEnvironment;
  deployment_status: ManagedProjectDeploymentStatus;
  health_status: ManagedProjectHealthStatus;
  assigned_agent_ids: string[];
  recent_changes: ProjectChangeEntry[];
  recent_errors: ProjectErrorEntry[];
  pending_approval_id: string | null;
  last_deployed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SystemConfigEntry {
  config_key: string;
  config_value: unknown;
  updated_at: string;
  updated_by: string;
}

export interface SystemBackupRecord {
  backup_id: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  summary: Record<string, unknown>;
  created_by: string;
  created_at: string;
  restored_at: string | null;
}

export interface DatabaseHealthStats {
  db_path: string;
  integrity_ok: boolean;
  integrity_message: string;
  page_count: number;
  page_size: number;
  estimated_bytes: number;
  table_counts: {
    tasks: number;
    schedules: number;
    approvals: number;
    execution_attempts: number;
    agent_execution_jobs: number;
    agent_execution_logs: number;
    managed_agents: number;
    managed_models: number;
    managed_workers: number;
    managed_projects: number;
    system_backups: number;
  };
}

export interface OrchestrationStore extends ApprovalStore {
  getAppliedMigrations(): AppliedMigrationRecord[];
  getDbPath(): string;
  getDatabaseStats(): DatabaseHealthStats;
  close(): void;

  // Task operations
  createTask(input: CreateTaskPersistenceInput): {
    created: boolean;
    task: OrchestratedTaskRecord;
  };
  getTask(taskId: string): OrchestratedTaskRecord | null;
  getTaskByIdempotencyKey(key: string): OrchestratedTaskRecord | null;
  listTasks(filter?: { status?: TaskStatus; limit?: number }): OrchestratedTaskRecord[];
  updateTaskState(params: {
    taskId: string;
    status: TaskStatus;
    updatedAt: string;
    result?: Record<string, unknown> | null;
    error?: TaskError | null;
    approvalIds?: string[];
    retryCount?: number;
    nextRunAt?: string;
    event: TaskEventRecord;
  }): OrchestratedTaskRecord | null;

  // Task events
  appendTaskEvent(event: TaskEventRecord): void;
  listTaskEvents(taskId: string): TaskEventRecord[];
  listRecentTaskEvents(limit?: number): TaskEventRecord[];

  // Execution attempts & leases
  acquireNextTaskLease(params: {
    workerId: string;
    leaseToken: string;
    leaseDurationMs: number;
    maxConcurrentRunning: number;
    nowIso: string;
  }): LeasedTaskAttempt | null;
  heartbeatLease(params: {
    attemptId: string;
    leaseToken: string;
    leaseExpiresAt: string;
    nowIso: string;
  }): boolean;
  markExternalEffectDispatched(attemptId: string, leaseToken: string): boolean;
  completeAttempt(params: {
    attemptId: string;
    leaseToken: string;
    attemptStatus: ExecutionAttemptStatus;
    taskStatus: TaskStatus;
    nowIso: string;
    result?: Record<string, unknown> | null;
    error?: TaskError | null;
    runtimeType?: string | null;
    modelId?: string | null;
    retryCount?: number;
    nextRunAt?: string;
    event: TaskEventRecord;
  }): boolean;
  listExecutionAttempts(taskId: string): ExecutionAttemptRecord[];
  countActiveLeases(nowIso: string): number;
  recoverAbandonedLeases(nowIso: string): LeaseRecoveryReport;

  // Schedules
  createSchedule(schedule: ScheduleRecord): ScheduleRecord;
  getSchedule(scheduleId: string): ScheduleRecord | null;
  listSchedules(): ScheduleRecord[];
  listDueSchedules(nowIso: string): ScheduleRecord[];
  updateScheduleState(params: {
    scheduleId: string;
    enabled?: boolean;
    nextRunAt?: string;
    lastTaskId?: string | null;
    lastRunAt?: string | null;
    updatedAt: string;
  }): ScheduleRecord | null;

  // Stage 4 Agent Execution Jobs & Logs
  createAgentExecutionJob(params: {
    job: AgentExecutionJobRecord;
    initialLog: AgentExecutionLogRecord;
  }): {
    created: boolean;
    job: AgentExecutionJobRecord;
  };
  getAgentExecutionJob(jobId: string): AgentExecutionJobRecord | null;
  getAgentExecutionJobByIdempotencyKey(
    key: string,
  ): AgentExecutionJobRecord | null;
  listAgentExecutionJobs(filter?: {
    status?: AgentExecutionJobStatus;
    taskId?: string;
    agentId?: string;
    limit?: number;
  }): AgentExecutionJobRecord[];
  claimAgentExecutionJob(params: {
    jobId?: string;
    nowIso: string;
  }): AgentExecutionJobRecord | null;
  completeAgentExecutionJob(params: {
    jobId: string;
    status: 'completed' | 'failed' | 'queued' | 'cancelled';
    nowIso: string;
    result?: Record<string, unknown> | null;
    error?: AgentExecutionError | null;
    retryCount?: number;
    nextRunAt?: string;
    log: AgentExecutionLogRecord;
  }): AgentExecutionJobRecord | null;
  cancelAgentExecutionJob(params: {
    jobId: string;
    nowIso: string;
    error: AgentExecutionError;
    log: AgentExecutionLogRecord;
  }): AgentExecutionJobRecord | null;
  recoverInterruptedAgentExecutionJobs(
    nowIso: string,
  ): AgentExecutionRecoveryReport;
  appendAgentExecutionLog(log: AgentExecutionLogRecord): void;
  listAgentExecutionLogs(filter?: {
    jobId?: string;
    taskId?: string;
    agentId?: string;
    limit?: number;
  }): AgentExecutionLogRecord[];

  // Approvals (ApprovalStore)
  get(approvalId: string): ApprovalRecord | null;
  save(record: ApprovalRecord): void;
  listAll(): ApprovalRecord[];

  // Stage 4.5 Managed Agents
  saveManagedAgent(record: ManagedAgentRecord): ManagedAgentRecord;
  getManagedAgent(agentId: string): ManagedAgentRecord | null;
  listManagedAgents(filter?: {
    department?: ManagedAgentDepartment;
    status?: ManagedAgentStatus;
    limit?: number;
    offset?: number;
  }): { items: ManagedAgentRecord[]; total: number };
  deleteManagedAgent(agentId: string): boolean;

  // Stage 4.5 Managed Models
  saveManagedModel(record: ManagedModelRecord): ManagedModelRecord;
  getManagedModel(modelId: string): ManagedModelRecord | null;
  listManagedModels(filter?: {
    runtimeType?: string;
    source?: ManagedModelSource;
    limit?: number;
    offset?: number;
  }): { items: ManagedModelRecord[]; total: number };
  setManagedModelRole(
    modelId: string,
    role: 'default' | 'backup',
    updatedAt: string,
  ): ManagedModelRecord | null;
  deleteManagedModel(modelId: string): boolean;

  // Stage 4.5 Managed Workers
  saveManagedWorker(record: ManagedWorkerRecord): ManagedWorkerRecord;
  getManagedWorker(workerId: string): ManagedWorkerRecord | null;
  listManagedWorkers(filter?: {
    limit?: number;
    offset?: number;
  }): { items: ManagedWorkerRecord[]; total: number };
  deleteManagedWorker(workerId: string): boolean;

  // Stage 4.5 Managed Projects
  saveManagedProject(record: ManagedProjectRecord): ManagedProjectRecord;
  getManagedProject(projectId: string): ManagedProjectRecord | null;
  getManagedProjectBySlug(slug: string): ManagedProjectRecord | null;
  listManagedProjects(filter?: {
    environment?: ExecutionEnvironment;
    limit?: number;
    offset?: number;
  }): { items: ManagedProjectRecord[]; total: number };
  deleteManagedProject(projectId: string): boolean;

  // Stage 4.5 System Config KV & Backups
  getSystemConfigEntry(configKey: string): SystemConfigEntry | null;
  setSystemConfigEntry(entry: SystemConfigEntry): SystemConfigEntry;
  listSystemConfigEntries(): SystemConfigEntry[];
  saveSystemBackup(record: SystemBackupRecord): SystemBackupRecord;
  getSystemBackup(backupId: string): SystemBackupRecord | null;
  listSystemBackups(limit?: number): SystemBackupRecord[];
  markSystemBackupRestored(backupId: string, restoredAt: string): void;
  exportManagementSnapshot(): Record<string, unknown>;
  restoreManagementSnapshot(snapshot: Record<string, unknown>): void;
}
