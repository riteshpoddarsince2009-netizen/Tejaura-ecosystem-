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
