export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type ExecutionEnvironment = 'sandbox' | 'local' | 'staging' | 'production';
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface OwnerSessionInfo {
  owner_id: string;
  username: string;
  role: string;
  session_id: string;
  expires_at: string;
  idle_expires_at: string;
}

export interface AuthStatusResponse {
  ok: true;
  initialized: boolean;
  authenticated: boolean;
  embedded_frame?: boolean;
  owner?: OwnerSessionInfo;
  transport_error?: string;
}

export interface ActionCatalogItem {
  action: string;
  required_autonomy: AutonomyLevel;
  required_scope: string;
  owner_exclusive: boolean;
  allowed_environments: ExecutionEnvironment[];
  description: string;
}

export interface SecretInventoryItem {
  key: string;
  source: 'environment' | 'encrypted_vault';
  scope: string;
  present: boolean;
  updated_at: string | null;
}

export interface TrustedEndpointItem {
  endpoint_id: string;
  runtime_type: string;
  base_url: string;
  node_id: string;
  enabled: boolean;
  requires_auth: boolean;
  auth_token_env_var: string | null;
}

export interface SystemOverviewResponse {
  ok: true;
  generated_at: string;
  owner: OwnerSessionInfo;
  persistence: {
    engine: string;
    migrations_applied: Array<{ version: number; name: string; applied_at: string }>;
  };
  worker: {
    worker_id: string;
    active_leases: number;
    lifecycle: {
      active_global: number;
      max_concurrent_global: number;
      max_concurrent_per_model: number;
      queued_count: number;
      max_queue_size: number;
      open_circuits: string[];
    };
    primary_runtime: string;
    paid_api_fallback_enabled: boolean;
  };
  counts: {
    tasks_by_status: Record<TaskStatus, number>;
    total_tasks: number;
    pending_approvals: number;
    active_schedules: number;
    total_schedules: number;
    registered_models: number;
    verified_enabled_models: number;
    online_compute_nodes: number;
    trusted_endpoints: number;
  };
  action_catalog: ActionCatalogItem[];
  trusted_endpoints: TrustedEndpointItem[];
  secrets_inventory: SecretInventoryItem[];
  system_governance?: {
    system: Record<string, unknown> | null;
    principles: Record<string, boolean> | null;
    governance: {
      humanOwnerControl?: boolean;
      allowAgentSelfPermission?: boolean;
      allowAgentSelfApproval?: boolean;
      failClosedOnPolicyError?: boolean;
      defaultAutonomyLevel?: AutonomyLevel;
      maxAutonomousLevel?: AutonomyLevel;
      autonomyLevels?: Record<
        AutonomyLevel,
        { id: string; description: string }
      >;
    } | null;
    approval_gates: Record<
      string,
      { required: boolean; autonomyLevel: AutonomyLevel; allowAutoApprove: boolean }
    > | null;
    security: Record<string, unknown> | null;
  };
  rbac_roles?: Record<string, readonly string[]>;
  auth_posture?: {
    mfa_enrolled_count: number;
    recovery_codes_remaining: number;
    active_sessions_count: number;
    cookie_name: string;
    same_site: string;
    http_only: boolean;
    secure_cookie: boolean;
    enforce_https_in_deployment: boolean;
  };
}

export interface OrchestratedTask {
  id: string;
  type: string;
  title: string;
  description: string;
  status: TaskStatus;
  autonomy_level: AutonomyLevel;
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
  requested_by: string;
  assigned_agent_id: string | null;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: { code: string; message: string; retryable: boolean } | null;
  approval_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface TaskEvent {
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

export interface ExecutionAttempt {
  attempt_id: string;
  task_id: string;
  attempt_number: number;
  worker_id: string;
  lease_expires_at: string;
  status: string;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  runtime_type: string | null;
  model_id: string | null;
  external_effect_dispatched: boolean;
}

export interface ScheduleItem {
  id: string;
  name: string;
  description: string;
  interval_seconds: number;
  next_run_at: string;
  enabled: boolean;
  task_template: {
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
  };
  last_task_id: string | null;
  last_run_at: string | null;
  created_by: string;
  created_at: string;
}

export interface ApprovalItem {
  id: string;
  task_id: string;
  action: string;
  requested_by: string;
  requested_at: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reviewed_by: string | null;
  reviewed_at: string | null;
  reason: string;
  scope: {
    resources: string[];
    permissions: string[];
    single_use: boolean;
    expires_at: string | null;
  };
  environment: ExecutionEnvironment;
  consumed_at: string | null;
  consumed_for_task_id: string | null;
}

export type ModelSource = 'modelscope' | 'huggingface' | 'local_mirror' | 'owner_archive';
export type ModelInstallStatus = 'not_installed' | 'installed_unverified' | 'verified' | 'failed';

export interface ModelInventoryItem {
  model_id: string;
  model_name: string;
  model_family: string;
  model_version: string;
  runtime_type: string;
  compatibility_status: string;
  modality: string;
  capabilities: string[];
  quantization: string;
  context_length: number;
  enabled: boolean;
  availability: string;
  controlled_runtime_endpoint: string | null;
  source?: ModelSource;
  repo_id?: string;
  revision?: string;
  local_model_path?: string | null;
  size_mb?: number;
  format?: string;
  install_status?: ModelInstallStatus;
  verified_on_disk?: boolean;
  is_default?: boolean;
  is_backup?: boolean;
  last_verified_at?: string | null;
  last_error?: string | null;
  breaker: {
    consecutive_failures: number;
    circuit_open: boolean;
  };
  best_node_fit: {
    fits: boolean;
    code: string;
    reason: string;
  };
}

export interface ComputeNodeItem {
  node_id: string;
  name: string;
  location: string;
  online: boolean;
  has_gpu: boolean;
  total_ram_mb: number;
  available_ram_mb: number;
  total_vram_mb: number;
  available_vram_mb: number;
  supported_runtimes: string[];
  last_seen_at: string;
}

export interface AuditLogItem {
  id: string;
  timestamp: string;
  actor_type: string;
  actor_id: string;
  event_type: string;
  resource_type: string;
  resource_id: string;
  action: string;
  outcome: string;
  approval_id: string | null;
}

// ==================== Stage 4.5 Owner Management Types ====================

export interface OwnerProfileInfo {
  owner_id: string;
  username: string;
  email: string;
  display_name: string | null;
  timezone: string;
  role: string;
  created_at: string;
  updated_at: string;
  password_changed_at: string;
  mfa_enrolled_count: number;
  recovery_codes_remaining: number;
}

export interface MfaFactorInfo {
  factor_id: string;
  type: string;
  label: string;
  enabled: boolean;
  enrolled_at: string;
  last_used_at: string | null;
}

export interface ActiveSessionInfo {
  session_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  idle_expires_at: string;
  user_agent: string;
  ip_address: string;
  revoked_at: string | null;
  is_current: boolean;
}

export type AgentDepartment =
  | 'research'
  | 'engineering'
  | 'seo'
  | 'design'
  | 'content'
  | 'analytics'
  | 'customer_support';

export type AgentStatus = 'active' | 'paused' | 'disabled' | 'retired';

export interface ManagedAgentItem {
  id: string;
  name: string;
  department: AgentDepartment;
  role: string;
  description: string;
  status: AgentStatus;
  enabled: boolean;
  permitted_autonomy_level: 'L0' | 'L1' | 'L2' | 'L3';
  allowed_tool_ids: string[];
  preferred_model_ids: string[];
  backup_model_ids: string[];
  max_concurrent_jobs: number;
  timeout_ms: number;
  allowed_paths: string[];
  network_mode: 'none' | 'allowlisted_endpoints';
  last_health_status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  schema_version: string;
}

export interface AgentExecutionJobItem {
  job_id: string;
  task_id: string;
  agent_id: string;
  adapter_id: string;
  status: string;
  environment: ExecutionEnvironment;
  autonomy_level: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

export interface AgentExecutionLogItem {
  log_id: string;
  job_id: string | null;
  task_id: string;
  agent_id: string;
  requested_action: string;
  outcome: string;
  summary: string;
  created_at: string;
}

export interface ManagedWorkerItem {
  worker_id: string;
  name: string;
  runtime_type: string;
  node_id: string;
  base_url: string;
  requires_auth: boolean;
  auth_token_env_var: string | null;
  enabled: boolean;
  health_status: 'unknown' | 'online' | 'degraded' | 'offline';
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

export type ManagedProjectType = 'website' | 'web_app' | 'api_service' | 'automation';
export type ManagedProjectDeploymentStatus =
  | 'draft'
  | 'pending_approval'
  | 'deployed'
  | 'failed'
  | 'rolled_back';

export interface ManagedProjectItem {
  project_id: string;
  name: string;
  slug: string;
  project_type: ManagedProjectType;
  description: string;
  domain_url: string | null;
  workspace_path: string;
  environment: ExecutionEnvironment;
  deployment_status: ManagedProjectDeploymentStatus;
  health_status: string;
  assigned_agent_ids: string[];
  recent_changes: Array<{
    change_id: string;
    summary: string;
    actor_id: string;
    environment: string;
    created_at: string;
  }>;
  recent_errors: Array<{
    error_id: string;
    code: string;
    message: string;
    created_at: string;
  }>;
  pending_approval_id: string | null;
  last_deployed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SystemConfigSettings {
  maintenance_mode: boolean;
  max_queue_depth: number;
  auto_recover_leases: boolean;
  preferred_model_source: ModelSource;
  default_model_id: string | null;
  backup_model_id: string | null;
}

export interface SystemBackupItem {
  backup_id: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  summary: {
    agents: number;
    models: number;
    workers: number;
    projects: number;
  };
  created_by: string;
  created_at: string;
  restored_at: string | null;
}

export interface SystemAdminOverview {
  generated_at: string;
  database: {
    engine: string;
    integrity_ok: boolean;
    integrity_message: string;
    page_count: number;
    page_size: number;
    estimated_bytes: number;
    table_counts: Record<string, number>;
  };
  migrations: Array<{ version: number; name: string; applied_at: string }>;
  storage: {
    state_dir_bytes: number;
    backups_dir_bytes: number;
    db_estimated_bytes: number;
  };
  queue_health: {
    queued_tasks: number;
    queued_agent_jobs: number;
    active_leases: number;
    recent_failed_tasks: number;
    recent_failed_jobs: number;
  };
  workers_summary: {
    total: number;
    enabled: number;
    online: number;
    offline: number;
  };
  config: SystemConfigSettings;
  backups: SystemBackupItem[];
}

export interface UnifiedLogEntry {
  log_id: string;
  source: 'audit' | 'task_event' | 'agent_execution';
  severity: 'info' | 'warn' | 'error';
  timestamp: string;
  actor_id: string;
  action: string;
  outcome: string;
  resource_id: string;
  message: string;
}
