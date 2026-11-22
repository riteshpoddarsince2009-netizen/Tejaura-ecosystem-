import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Approval, Task, TaskError, TaskStatus } from '../../contracts/types/index.ts';
import { validateApproval, validateTask } from '../../contracts/validation/index.ts';
import { toContractApproval, type ApprovalRecord } from '../../core/approvals/index.ts';
import { applyStage3Migrations, type AppliedMigrationRecord } from './migrations.ts';
import type {
  AgentExecutionError,
  AgentExecutionJobRecord,
  AgentExecutionJobStatus,
  AgentExecutionLogOutcome,
  AgentExecutionLogRecord,
  AgentExecutionRecoveryReport,
  AgentPermissionDecision,
  CreateTaskPersistenceInput,
  DatabaseHealthStats,
  ExecutionAttemptRecord,
  ExecutionAttemptStatus,
  LeaseRecoveryReport,
  LeasedTaskAttempt,
  ManagedAgentDepartment,
  ManagedAgentHealth,
  ManagedAgentRecord,
  ManagedAgentStatus,
  ManagedModelRecord,
  ManagedModelSource,
  ManagedProjectDeploymentStatus,
  ManagedProjectHealthStatus,
  ManagedProjectRecord,
  ManagedProjectType,
  ManagedWorkerHealthStatus,
  ManagedWorkerRecord,
  ModelInstallStatus,
  OrchestratedTaskRecord,
  OrchestrationStore,
  ProjectChangeEntry,
  ProjectErrorEntry,
  SandboxBrowserMode,
  SandboxIsolationLevel,
  SandboxNetworkMode,
  ScheduleRecord,
  ScheduleTaskTemplate,
  SystemBackupRecord,
  SystemConfigEntry,
  TaskEventRecord,
} from './store-types.ts';

const FORBIDDEN_PUBLIC_DIR_NAMES = new Set([
  'public',
  'dist',
  'build',
  'src',
  'static',
  'www',
]);

export function toContractTask(record: OrchestratedTaskRecord): Task {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    description: record.description,
    status: record.status,
    autonomy_level: record.autonomy_level,
    created_at: record.created_at,
    updated_at: record.updated_at,
    requested_by: record.requested_by,
    assigned_agent_id: record.assigned_agent_id,
    input: record.input,
    result: record.result,
    error: record.error,
    approval_ids: record.approval_ids,
    schema_version: record.schema_version,
  };
}

interface RawTaskRow {
  id: string;
  type: string;
  title: string;
  description: string;
  status: TaskStatus;
  autonomy_level: Task['autonomy_level'];
  environment: OrchestratedTaskRecord['environment'];
  action: string;
  resource_id: string;
  declared_scopes_json: string;
  priority: number;
  idempotency_key: string | null;
  idempotent_action: number;
  deadline_at: string | null;
  retry_count: number;
  max_retries: number;
  timeout_ms: number;
  next_run_at: string;
  schedule_id: string | null;
  requested_by: string;
  assigned_agent_id: string | null;
  input_json: string;
  result_json: string | null;
  error_json: string | null;
  approval_ids_json: string;
  created_at: string;
  updated_at: string;
  schema_version: string;
}

interface RawAttemptRow {
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
  external_effect_dispatched: number;
}

interface RawEventRow {
  event_id: string;
  task_id: string;
  event_type: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  actor_id: string;
  message: string;
  metadata_json: string;
  created_at: string;
}

interface RawScheduleRow {
  id: string;
  name: string;
  description: string;
  interval_seconds: number;
  next_run_at: string;
  enabled: number;
  task_template_json: string;
  last_task_id: string | null;
  last_run_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface RawApprovalRow {
  id: string;
  task_id: string;
  action: string;
  requested_by: string;
  requested_at: string;
  status: Approval['status'];
  reviewed_by: string | null;
  reviewed_at: string | null;
  reason: string;
  scope_json: string;
  environment: ApprovalRecord['environment'];
  consumed_at: string | null;
  consumed_for_task_id: string | null;
  schema_version: string;
}

interface RawAgentJobRow {
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
  environment: OrchestratedTaskRecord['environment'];
  permission_decision: AgentPermissionDecision;
  policy_reason_code: string;
  approval_id: string | null;
  tool_ids_json: string;
  declared_scopes_json: string;
  allowed_paths_json: string;
  network_mode: SandboxNetworkMode;
  network_allowlist_json: string;
  browser_mode: SandboxBrowserMode;
  input_json: string;
  idempotency_key: string | null;
  idempotent_action: number;
  retry_count: number;
  max_retries: number;
  timeout_ms: number;
  next_run_at: string;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface RawAgentExecutionLogRow {
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
  details_json: string;
  secrets_redacted: number;
  created_at: string;
}

interface RawManagedAgentRow {
  id: string;
  name: string;
  department: ManagedAgentDepartment;
  role: string;
  description: string;
  status: ManagedAgentStatus;
  enabled: number;
  permitted_autonomy_level: ManagedAgentRecord['permitted_autonomy_level'];
  allowed_tool_ids_json: string;
  preferred_model_ids_json: string;
  backup_model_ids_json: string;
  max_concurrent_jobs: number;
  timeout_ms: number;
  allowed_paths_json: string;
  network_mode: SandboxNetworkMode;
  last_health_status: ManagedAgentHealth;
  created_by: string;
  created_at: string;
  updated_at: string;
  schema_version: string;
}

interface RawManagedModelRow {
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
  compatibility_status: ManagedModelRecord['compatibility_status'];
  modality: ManagedModelRecord['modality'];
  capabilities_json: string;
  hardware_requirements_json: string;
  quantization: string;
  context_length: number;
  size_mb: number;
  format: string;
  install_status: ModelInstallStatus;
  verified_on_disk: number;
  is_default: number;
  is_backup: number;
  enabled: number;
  availability: string;
  license_json: string;
  node_id: string | null;
  last_verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface RawManagedWorkerRow {
  worker_id: string;
  name: string;
  runtime_type: string;
  node_id: string;
  base_url: string;
  requires_auth: number;
  auth_token_env_var: string | null;
  enabled: number;
  health_status: ManagedWorkerHealthStatus;
  current_model_id: string | null;
  active_jobs: number;
  queue_length: number;
  latency_ms: number | null;
  discovered_models_json: string;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface RawManagedProjectRow {
  project_id: string;
  name: string;
  slug: string;
  project_type: ManagedProjectType;
  description: string;
  domain_url: string | null;
  workspace_path: string;
  environment: OrchestratedTaskRecord['environment'];
  deployment_status: ManagedProjectDeploymentStatus;
  health_status: ManagedProjectHealthStatus;
  assigned_agent_ids_json: string;
  recent_changes_json: string;
  recent_errors_json: string;
  pending_approval_id: string | null;
  last_deployed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface RawSystemConfigRow {
  config_key: string;
  config_value_json: string;
  updated_at: string;
  updated_by: string;
}

interface RawSystemBackupRow {
  backup_id: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  summary_json: string;
  created_by: string;
  created_at: string;
  restored_at: string | null;
}

function assertSafeDbFilePath(dbPath: string): string {
  if (dbPath === ':memory:') {
    return dbPath;
  }
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) {
    throw new Error('Database path must be a non-empty file path or ":memory:".');
  }
  const resolved = path.resolve(dbPath);
  const dir = path.dirname(resolved);
  const segments = dir
    .split(path.sep)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
  if (
    segments.some((s) => FORBIDDEN_PUBLIC_DIR_NAMES.has(s)) ||
    fs.existsSync(path.join(dir, 'index.html'))
  ) {
    throw new Error(
      'Refusing to place SQLite database inside a public or web-served directory.',
    );
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return resolved;
}

function hydrateTaskRow(row: RawTaskRow): OrchestratedTaskRecord {
  const record: OrchestratedTaskRecord = {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    status: row.status,
    autonomy_level: row.autonomy_level,
    environment: row.environment,
    action: row.action,
    resource_id: row.resource_id,
    declared_scopes: JSON.parse(row.declared_scopes_json) as string[],
    priority: row.priority,
    idempotency_key: row.idempotency_key,
    idempotent_action: row.idempotent_action === 1,
    deadline_at: row.deadline_at,
    retry_count: row.retry_count,
    max_retries: row.max_retries,
    timeout_ms: row.timeout_ms,
    next_run_at: row.next_run_at,
    schedule_id: row.schedule_id,
    requested_by: row.requested_by,
    assigned_agent_id: row.assigned_agent_id,
    input: JSON.parse(row.input_json) as Record<string, unknown>,
    result: row.result_json
      ? (JSON.parse(row.result_json) as Record<string, unknown>)
      : null,
    error: row.error_json ? (JSON.parse(row.error_json) as TaskError) : null,
    approval_ids: JSON.parse(row.approval_ids_json) as string[],
    created_at: row.created_at,
    updated_at: row.updated_at,
    schema_version: row.schema_version,
  };

  const check = validateTask(toContractTask(record));
  if (!check.valid) {
    throw new Error(
      `Persisted task "${record.id}" failed contract validation: ${check.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return record;
}

function hydrateAttemptRow(row: RawAttemptRow): ExecutionAttemptRecord {
  return {
    attempt_id: row.attempt_id,
    task_id: row.task_id,
    attempt_number: row.attempt_number,
    worker_id: row.worker_id,
    lease_token: row.lease_token,
    lease_expires_at: row.lease_expires_at,
    status: row.status,
    started_at: row.started_at,
    heartbeat_at: row.heartbeat_at,
    finished_at: row.finished_at,
    error_code: row.error_code,
    error_message: row.error_message,
    runtime_type: row.runtime_type,
    model_id: row.model_id,
    external_effect_dispatched: row.external_effect_dispatched === 1,
  };
}

function hydrateEventRow(row: RawEventRow): TaskEventRecord {
  return {
    event_id: row.event_id,
    task_id: row.task_id,
    event_type: row.event_type,
    from_status: row.from_status,
    to_status: row.to_status,
    actor_id: row.actor_id,
    message: row.message,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    created_at: row.created_at,
  };
}

function hydrateScheduleRow(row: RawScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    interval_seconds: row.interval_seconds,
    next_run_at: row.next_run_at,
    enabled: row.enabled === 1,
    task_template: JSON.parse(row.task_template_json) as ScheduleTaskTemplate,
    last_task_id: row.last_task_id,
    last_run_at: row.last_run_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function hydrateApprovalRow(row: RawApprovalRow): ApprovalRecord {
  const record: ApprovalRecord = {
    id: row.id,
    task_id: row.task_id,
    action: row.action,
    requested_by: row.requested_by,
    requested_at: row.requested_at,
    status: row.status,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    reason: row.reason,
    scope: JSON.parse(row.scope_json) as Approval['scope'],
    environment: row.environment,
    consumed_at: row.consumed_at,
    consumed_for_task_id: row.consumed_for_task_id,
    schema_version: row.schema_version,
  };
  const check = validateApproval(toContractApproval(record));
  if (!check.valid) {
    throw new Error(
      `Persisted approval "${record.id}" failed contract validation: ${check.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return record;
}

function hydrateAgentJobRow(row: RawAgentJobRow): AgentExecutionJobRecord {
  return {
    job_id: row.job_id,
    task_id: row.task_id,
    attempt_id: row.attempt_id,
    agent_id: row.agent_id,
    agent_department: row.agent_department,
    agent_role: row.agent_role,
    sandbox_provider: row.sandbox_provider,
    isolation_level: row.isolation_level,
    status: row.status,
    requested_action: row.requested_action,
    resource_id: row.resource_id,
    environment: row.environment,
    permission_decision: row.permission_decision,
    policy_reason_code: row.policy_reason_code,
    approval_id: row.approval_id,
    tool_ids: JSON.parse(row.tool_ids_json) as string[],
    declared_scopes: JSON.parse(row.declared_scopes_json) as string[],
    allowed_paths: JSON.parse(row.allowed_paths_json) as string[],
    network_mode: row.network_mode,
    network_allowlist: JSON.parse(row.network_allowlist_json) as string[],
    browser_mode: row.browser_mode,
    input: JSON.parse(row.input_json) as Record<string, unknown>,
    idempotency_key: row.idempotency_key,
    idempotent_action: row.idempotent_action === 1,
    retry_count: row.retry_count,
    max_retries: row.max_retries,
    timeout_ms: row.timeout_ms,
    next_run_at: row.next_run_at,
    result: row.result_json
      ? (JSON.parse(row.result_json) as Record<string, unknown>)
      : null,
    error: row.error_json
      ? (JSON.parse(row.error_json) as AgentExecutionError)
      : null,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    updated_at: row.updated_at,
  };
}

function hydrateAgentExecutionLogRow(
  row: RawAgentExecutionLogRow,
): AgentExecutionLogRecord {
  return {
    log_id: row.log_id,
    job_id: row.job_id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    requested_action: row.requested_action,
    permission_decision: row.permission_decision,
    policy_reason_code: row.policy_reason_code,
    approval_id: row.approval_id,
    outcome: row.outcome,
    summary: row.summary,
    details: JSON.parse(row.details_json) as Record<string, unknown>,
    secrets_redacted: row.secrets_redacted === 1,
    created_at: row.created_at,
  };
}

function hydrateManagedAgentRow(row: RawManagedAgentRow): ManagedAgentRecord {
  return {
    id: row.id,
    name: row.name,
    department: row.department,
    role: row.role,
    description: row.description,
    status: row.status,
    enabled: row.enabled === 1,
    permitted_autonomy_level: row.permitted_autonomy_level,
    allowed_tool_ids: JSON.parse(row.allowed_tool_ids_json) as string[],
    preferred_model_ids: JSON.parse(row.preferred_model_ids_json) as string[],
    backup_model_ids: JSON.parse(row.backup_model_ids_json) as string[],
    max_concurrent_jobs: row.max_concurrent_jobs,
    timeout_ms: row.timeout_ms,
    allowed_paths: JSON.parse(row.allowed_paths_json) as string[],
    network_mode: row.network_mode,
    last_health_status: row.last_health_status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    schema_version: row.schema_version,
  };
}

function hydrateManagedModelRow(row: RawManagedModelRow): ManagedModelRecord {
  return {
    model_id: row.model_id,
    model_name: row.model_name,
    model_family: row.model_family,
    model_version: row.model_version,
    source: row.source,
    repo_id: row.repo_id,
    revision: row.revision,
    local_model_path: row.local_model_path,
    controlled_runtime_endpoint: row.controlled_runtime_endpoint,
    runtime_type: row.runtime_type,
    compatibility_status: row.compatibility_status,
    modality: row.modality,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    hardware_requirements: JSON.parse(
      row.hardware_requirements_json,
    ) as ManagedModelRecord['hardware_requirements'],
    quantization: row.quantization,
    context_length: row.context_length,
    size_mb: row.size_mb,
    format: row.format,
    install_status: row.install_status,
    verified_on_disk: row.verified_on_disk === 1,
    is_default: row.is_default === 1,
    is_backup: row.is_backup === 1,
    enabled: row.enabled === 1,
    availability: row.availability,
    license: JSON.parse(row.license_json) as ManagedModelRecord['license'],
    node_id: row.node_id,
    last_verified_at: row.last_verified_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function hydrateManagedWorkerRow(row: RawManagedWorkerRow): ManagedWorkerRecord {
  return {
    worker_id: row.worker_id,
    name: row.name,
    runtime_type: row.runtime_type,
    node_id: row.node_id,
    base_url: row.base_url,
    requires_auth: row.requires_auth === 1,
    auth_token_env_var: row.auth_token_env_var,
    enabled: row.enabled === 1,
    health_status: row.health_status,
    current_model_id: row.current_model_id,
    active_jobs: row.active_jobs,
    queue_length: row.queue_length,
    latency_ms: row.latency_ms,
    discovered_models: JSON.parse(row.discovered_models_json) as string[],
    last_checked_at: row.last_checked_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function hydrateManagedProjectRow(row: RawManagedProjectRow): ManagedProjectRecord {
  return {
    project_id: row.project_id,
    name: row.name,
    slug: row.slug,
    project_type: row.project_type,
    description: row.description,
    domain_url: row.domain_url,
    workspace_path: row.workspace_path,
    environment: row.environment,
    deployment_status: row.deployment_status,
    health_status: row.health_status,
    assigned_agent_ids: JSON.parse(row.assigned_agent_ids_json) as string[],
    recent_changes: JSON.parse(row.recent_changes_json) as ProjectChangeEntry[],
    recent_errors: JSON.parse(row.recent_errors_json) as ProjectErrorEntry[],
    pending_approval_id: row.pending_approval_id,
    last_deployed_at: row.last_deployed_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function hydrateSystemConfigRow(row: RawSystemConfigRow): SystemConfigEntry {
  return {
    config_key: row.config_key,
    config_value: JSON.parse(row.config_value_json) as unknown,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

function hydrateSystemBackupRow(row: RawSystemBackupRow): SystemBackupRecord {
  return {
    backup_id: row.backup_id,
    filename: row.filename,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    summary: JSON.parse(row.summary_json) as Record<string, unknown>,
    created_by: row.created_by,
    created_at: row.created_at,
    restored_at: row.restored_at,
  };
}

/**
 * Persistent SQLite-backed OrchestrationStore & ApprovalStore using Node 22
 * built-in `node:sqlite` (`DatabaseSync`) with WAL mode, migrations, contract
 * validation, worker leases, and crash/restart recovery.
 */
export class SqliteOrchestrationStore implements OrchestrationStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly migrations: AppliedMigrationRecord[];

  constructor(options: { dbPath: string }) {
    const safePath = assertSafeDbFilePath(options.dbPath);
    this.dbPath = safePath;
    this.db = new DatabaseSync(safePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrations = applyStage3Migrations(this.db);

    if (safePath !== ':memory:' && fs.existsSync(safePath)) {
      fs.chmodSync(safePath, 0o600);
    }
  }

  getAppliedMigrations(): AppliedMigrationRecord[] {
    return [...this.migrations];
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getDatabaseStats(): DatabaseHealthStats {
    const integrityRow = this.db
      .prepare('PRAGMA integrity_check;')
      .get() as { integrity_check?: string } | undefined;
    const integrityMessage = integrityRow?.integrity_check ?? 'unknown';
    const pageCountRow = this.db
      .prepare('PRAGMA page_count;')
      .get() as { page_count?: number } | undefined;
    const pageSizeRow = this.db
      .prepare('PRAGMA page_size;')
      .get() as { page_size?: number } | undefined;
    const pageCount = pageCountRow?.page_count ?? 0;
    const pageSize = pageSizeRow?.page_size ?? 4096;

    const countTable = (table: string): number => {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS cnt FROM ${table}`)
        .get() as { cnt: number };
      return row.cnt;
    };

    let estimatedBytes = pageCount * pageSize;
    if (this.dbPath !== ':memory:' && fs.existsSync(this.dbPath)) {
      estimatedBytes = fs.statSync(this.dbPath).size;
    }

    return {
      db_path: this.dbPath === ':memory:' ? ':memory:' : path.basename(this.dbPath),
      integrity_ok: integrityMessage.toLowerCase() === 'ok',
      integrity_message: integrityMessage,
      page_count: pageCount,
      page_size: pageSize,
      estimated_bytes: estimatedBytes,
      table_counts: {
        tasks: countTable('tasks'),
        schedules: countTable('schedules'),
        approvals: countTable('approvals'),
        execution_attempts: countTable('execution_attempts'),
        agent_execution_jobs: countTable('agent_execution_jobs'),
        agent_execution_logs: countTable('agent_execution_logs'),
        managed_agents: countTable('managed_agents'),
        managed_models: countTable('managed_models'),
        managed_workers: countTable('managed_workers'),
        managed_projects: countTable('managed_projects'),
        system_backups: countTable('system_backups'),
      },
    };
  }

  close(): void {
    this.db.close();
  }

  createTask(input: CreateTaskPersistenceInput): {
    created: boolean;
    task: OrchestratedTaskRecord;
  } {
    const check = validateTask(toContractTask(input.task));
    if (!check.valid) {
      throw new Error(
        `Refusing to persist invalid task: ${check.errors.map((e) => e.message).join('; ')}`,
      );
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (input.task.idempotency_key) {
        const existingRow = this.db
          .prepare('SELECT * FROM tasks WHERE idempotency_key = ?')
          .get(input.task.idempotency_key) as unknown as RawTaskRow | undefined;
        if (existingRow) {
          this.db.exec('COMMIT');
          return { created: false, task: hydrateTaskRow(existingRow) };
        }
      }

      this.db
        .prepare(
          `INSERT INTO tasks (
            id, type, title, description, status, autonomy_level, environment,
            action, resource_id, declared_scopes_json, priority, idempotency_key,
            idempotent_action, deadline_at, retry_count, max_retries, timeout_ms,
            next_run_at, schedule_id, requested_by, assigned_agent_id,
            input_json, result_json, error_json, approval_ids_json,
            created_at, updated_at, schema_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.task.id,
          input.task.type,
          input.task.title,
          input.task.description,
          input.task.status,
          input.task.autonomy_level,
          input.task.environment,
          input.task.action,
          input.task.resource_id,
          JSON.stringify(input.task.declared_scopes),
          input.task.priority,
          input.task.idempotency_key,
          input.task.idempotent_action ? 1 : 0,
          input.task.deadline_at,
          input.task.retry_count,
          input.task.max_retries,
          input.task.timeout_ms,
          input.task.next_run_at,
          input.task.schedule_id,
          input.task.requested_by,
          input.task.assigned_agent_id,
          JSON.stringify(input.task.input),
          input.task.result ? JSON.stringify(input.task.result) : null,
          input.task.error ? JSON.stringify(input.task.error) : null,
          JSON.stringify(input.task.approval_ids),
          input.task.created_at,
          input.task.updated_at,
          input.task.schema_version ?? '1.0.0',
        );

      if (input.task.idempotency_key) {
        this.db
          .prepare(
            `INSERT INTO idempotency_records (
              idempotency_key, task_id, effect_state, created_at, updated_at
            ) VALUES (?, ?, 'pending', ?, ?)`,
          )
          .run(
            input.task.idempotency_key,
            input.task.id,
            input.task.created_at,
            input.task.updated_at,
          );
      }

      this.insertEventRow(input.initialEvent);
      this.db.exec('COMMIT');

      const createdRow = this.db
        .prepare('SELECT * FROM tasks WHERE id = ?')
        .get(input.task.id) as unknown as RawTaskRow;
      return { created: true, task: hydrateTaskRow(createdRow) };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private insertEventRow(event: TaskEventRecord): void {
    this.db
      .prepare(
        `INSERT INTO task_events (
          event_id, task_id, event_type, from_status, to_status,
          actor_id, message, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.event_id,
        event.task_id,
        event.event_type,
        event.from_status,
        event.to_status,
        event.actor_id,
        event.message,
        JSON.stringify(event.metadata),
        event.created_at,
      );
  }

  getTask(taskId: string): OrchestratedTaskRecord | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(taskId) as unknown as RawTaskRow | undefined;
    return row ? hydrateTaskRow(row) : null;
  }

  getTaskByIdempotencyKey(key: string): OrchestratedTaskRecord | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE idempotency_key = ?')
      .get(key) as unknown as RawTaskRow | undefined;
    return row ? hydrateTaskRow(row) : null;
  }

  listTasks(filter?: {
    status?: TaskStatus;
    limit?: number;
  }): OrchestratedTaskRecord[] {
    const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 500);
    const rows = filter?.status
      ? (this.db
          .prepare(
            'SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(filter.status, limit) as unknown as RawTaskRow[])
      : (this.db
          .prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?')
          .all(limit) as unknown as RawTaskRow[]);

    return rows.map(hydrateTaskRow);
  }

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
  }): OrchestratedTaskRecord | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getTask(params.taskId);
      if (!existing) {
        this.db.exec('ROLLBACK');
        return null;
      }

      const nextRecord: OrchestratedTaskRecord = {
        ...existing,
        status: params.status,
        updated_at: params.updatedAt,
        result: params.result !== undefined ? params.result : existing.result,
        error: params.error !== undefined ? params.error : existing.error,
        approval_ids: params.approvalIds ?? existing.approval_ids,
        retry_count: params.retryCount ?? existing.retry_count,
        next_run_at: params.nextRunAt ?? existing.next_run_at,
      };

      const check = validateTask(toContractTask(nextRecord));
      if (!check.valid) {
        throw new Error(
          `Refusing invalid task transition: ${check.errors.map((e) => e.message).join('; ')}`,
        );
      }

      this.db
        .prepare(
          `UPDATE tasks
           SET status = ?, updated_at = ?, result_json = ?, error_json = ?,
               approval_ids_json = ?, retry_count = ?, next_run_at = ?
           WHERE id = ?`,
        )
        .run(
          nextRecord.status,
          nextRecord.updated_at,
          nextRecord.result ? JSON.stringify(nextRecord.result) : null,
          nextRecord.error ? JSON.stringify(nextRecord.error) : null,
          JSON.stringify(nextRecord.approval_ids),
          nextRecord.retry_count,
          nextRecord.next_run_at,
          nextRecord.id,
        );

      if (nextRecord.status === 'cancelled') {
        this.db
          .prepare(
            `UPDATE execution_attempts
             SET status = 'cancelled', finished_at = ?, error_code = 'TASK_CANCELLED', error_message = 'Task cancelled.'
             WHERE task_id = ? AND status IN ('leased', 'running')`,
          )
          .run(params.updatedAt, nextRecord.id);
      }

      this.insertEventRow(params.event);
      this.db.exec('COMMIT');
      return nextRecord;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  appendTaskEvent(event: TaskEventRecord): void {
    this.insertEventRow(event);
  }

  listTaskEvents(taskId: string): TaskEventRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC',
      )
      .all(taskId) as unknown as RawEventRow[];
    return rows.map(hydrateEventRow);
  }

  listRecentTaskEvents(limit = 100): TaskEventRecord[] {
    const clamped = Math.min(Math.max(Math.round(limit), 1), 500);
    const rows = this.db
      .prepare(
        'SELECT * FROM task_events ORDER BY created_at DESC LIMIT ?',
      )
      .all(clamped) as unknown as RawEventRow[];
    return rows.map(hydrateEventRow);
  }

  countActiveLeases(nowIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM execution_attempts
         WHERE status IN ('leased', 'running') AND lease_expires_at > ?`,
      )
      .get(nowIso) as { cnt: number };
    return row.cnt;
  }

  acquireNextTaskLease(params: {
    workerId: string;
    leaseToken: string;
    leaseDurationMs: number;
    maxConcurrentRunning: number;
    nowIso: string;
  }): LeasedTaskAttempt | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const activeCount = this.countActiveLeases(params.nowIso);
      if (activeCount >= params.maxConcurrentRunning) {
        this.db.exec('COMMIT');
        return null;
      }

      // First expire any queued tasks whose deadline has passed.
      const expiredQueued = this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE status = 'queued' AND deadline_at IS NOT NULL AND deadline_at <= ?`,
        )
        .all(params.nowIso) as unknown as RawTaskRow[];

      for (const row of expiredQueued) {
        const deadlineErr: TaskError = {
          code: 'TASK_DEADLINE_EXCEEDED',
          message: `Task deadline (${row.deadline_at}) passed before execution began.`,
          retryable: false,
        };
        this.db
          .prepare(
            `UPDATE tasks SET status = 'failed', updated_at = ?, error_json = ? WHERE id = ?`,
          )
          .run(params.nowIso, JSON.stringify(deadlineErr), row.id);

        this.insertEventRow({
          event_id: `evt_${crypto.randomUUID()}`,
          task_id: row.id,
          event_type: 'task.deadline_exceeded',
          from_status: 'queued',
          to_status: 'failed',
          actor_id: params.workerId,
          message: deadlineErr.message,
          metadata: { deadline_at: row.deadline_at },
          created_at: params.nowIso,
        });
      }

      const candidate = this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE status = 'queued'
             AND next_run_at <= ?
             AND (deadline_at IS NULL OR deadline_at > ?)
           ORDER BY priority DESC, created_at ASC
           LIMIT 1`,
        )
        .get(params.nowIso, params.nowIso) as unknown as RawTaskRow | undefined;

      if (!candidate) {
        this.db.exec('COMMIT');
        return null;
      }

      const attemptCountRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(attempt_number), 0) AS max_num FROM execution_attempts WHERE task_id = ?',
        )
        .get(candidate.id) as { max_num: number };
      const attemptNumber = attemptCountRow.max_num + 1;
      const attemptId = `att_${crypto.randomUUID()}`;
      const leaseExpiresAt = new Date(
        new Date(params.nowIso).getTime() + params.leaseDurationMs,
      ).toISOString();

      this.db
        .prepare(
          `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'`,
        )
        .run(params.nowIso, candidate.id);

      this.db
        .prepare(
          `INSERT INTO execution_attempts (
            attempt_id, task_id, attempt_number, worker_id, lease_token,
            lease_expires_at, status, started_at, heartbeat_at,
            finished_at, error_code, error_message, runtime_type, model_id,
            external_effect_dispatched
          ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, NULL, NULL, NULL, NULL, NULL, 0)`,
        )
        .run(
          attemptId,
          candidate.id,
          attemptNumber,
          params.workerId,
          params.leaseToken,
          leaseExpiresAt,
          params.nowIso,
          params.nowIso,
        );

      this.insertEventRow({
        event_id: `evt_${crypto.randomUUID()}`,
        task_id: candidate.id,
        event_type: 'task.leased',
        from_status: 'queued',
        to_status: 'running',
        actor_id: params.workerId,
        message: `Execution attempt #${attemptNumber} leased to worker "${params.workerId}".`,
        metadata: {
          attempt_id: attemptId,
          attempt_number: attemptNumber,
          lease_expires_at: leaseExpiresAt,
        },
        created_at: params.nowIso,
      });

      this.db.exec('COMMIT');

      const updatedTask = this.getTask(candidate.id)!;
      const attemptRow = this.db
        .prepare('SELECT * FROM execution_attempts WHERE attempt_id = ?')
        .get(attemptId) as unknown as RawAttemptRow;

      return {
        task: updatedTask,
        attempt: hydrateAttemptRow(attemptRow),
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  heartbeatLease(params: {
    attemptId: string;
    leaseToken: string;
    leaseExpiresAt: string;
    nowIso: string;
  }): boolean {
    const info = this.db
      .prepare(
        `UPDATE execution_attempts
         SET heartbeat_at = ?, lease_expires_at = ?
         WHERE attempt_id = ? AND lease_token = ? AND status IN ('leased', 'running')`,
      )
      .run(
        params.nowIso,
        params.leaseExpiresAt,
        params.attemptId,
        params.leaseToken,
      );
    return info.changes > 0;
  }

  markExternalEffectDispatched(attemptId: string, leaseToken: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const attempt = this.db
        .prepare(
          `SELECT * FROM execution_attempts WHERE attempt_id = ? AND lease_token = ? AND status IN ('leased', 'running')`,
        )
        .get(attemptId, leaseToken) as unknown as RawAttemptRow | undefined;
      if (!attempt) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db
        .prepare(
          `UPDATE execution_attempts SET external_effect_dispatched = 1 WHERE attempt_id = ?`,
        )
        .run(attemptId);
      this.db
        .prepare(
          `UPDATE idempotency_records SET effect_state = 'dispatched', updated_at = ? WHERE task_id = ?`,
        )
        .run(new Date().toISOString(), attempt.task_id);
      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

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
  }): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const attemptRow = this.db
        .prepare(
          `SELECT * FROM execution_attempts WHERE attempt_id = ? AND lease_token = ?`,
        )
        .get(params.attemptId, params.leaseToken) as unknown as RawAttemptRow | undefined;

      if (!attemptRow || !['leased', 'running'].includes(attemptRow.status)) {
        this.db.exec('ROLLBACK');
        return false;
      }

      const task = this.getTask(attemptRow.task_id);
      if (!task) {
        this.db.exec('ROLLBACK');
        return false;
      }

      // If task was already cancelled externally while running, do not overwrite cancelled state with succeeded/failed.
      const effectiveTaskStatus: TaskStatus =
        task.status === 'cancelled' ? 'cancelled' : params.taskStatus;

      const candidateTask: OrchestratedTaskRecord = {
        ...task,
        status: effectiveTaskStatus,
        updated_at: params.nowIso,
        result: params.result !== undefined ? params.result : task.result,
        error: params.error !== undefined ? params.error : task.error,
        retry_count: params.retryCount ?? task.retry_count,
        next_run_at: params.nextRunAt ?? task.next_run_at,
      };
      const check = validateTask(toContractTask(candidateTask));
      if (!check.valid) {
        throw new Error(
          `Refusing invalid task completion: ${check.errors.map((e) => e.message).join('; ')}`,
        );
      }

      this.db
        .prepare(
          `UPDATE execution_attempts
           SET status = ?, finished_at = ?, error_code = ?, error_message = ?,
               runtime_type = ?, model_id = ?
           WHERE attempt_id = ?`,
        )
        .run(
          task.status === 'cancelled' ? 'cancelled' : params.attemptStatus,
          params.nowIso,
          params.error?.code ?? null,
          params.error?.message ?? null,
          params.runtimeType ?? null,
          params.modelId ?? null,
          params.attemptId,
        );

      if (task.status !== 'cancelled') {
        this.db
          .prepare(
            `UPDATE tasks
             SET status = ?, updated_at = ?, result_json = ?, error_json = ?,
                 retry_count = ?, next_run_at = ?
             WHERE id = ?`,
          )
          .run(
            effectiveTaskStatus,
            params.nowIso,
            candidateTask.result ? JSON.stringify(candidateTask.result) : null,
            candidateTask.error ? JSON.stringify(candidateTask.error) : null,
            candidateTask.retry_count,
            candidateTask.next_run_at,
            task.id,
          );
      }

      if (effectiveTaskStatus === 'succeeded' || effectiveTaskStatus === 'cancelled') {
        this.db
          .prepare(
            `UPDATE idempotency_records SET effect_state = ?, updated_at = ? WHERE task_id = ?`,
          )
          .run(
            effectiveTaskStatus === 'succeeded' ? 'completed' : 'cancelled',
            params.nowIso,
            task.id,
          );
      }

      this.insertEventRow(params.event);
      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listExecutionAttempts(taskId: string): ExecutionAttemptRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY attempt_number DESC',
      )
      .all(taskId) as unknown as RawAttemptRow[];
    return rows.map(hydrateAttemptRow);
  }

  /**
   * Recovers expired worker leases safely after a worker crash or process restart.
   * Non-idempotent external actions with dispatched effects are NEVER retried
   * automatically without explicit owner inspection.
   */
  recoverAbandonedLeases(nowIso: string): LeaseRecoveryReport {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const staleRows = this.db
        .prepare(
          `SELECT * FROM execution_attempts
           WHERE status IN ('leased', 'running') AND lease_expires_at <= ?`,
        )
        .all(nowIso) as unknown as RawAttemptRow[];

      const requeued: string[] = [];
      const failed: string[] = [];

      for (const stale of staleRows) {
        const task = this.getTask(stale.task_id);
        this.db
          .prepare(
            `UPDATE execution_attempts
             SET status = 'abandoned', finished_at = ?,
                 error_code = 'WORKER_LEASE_EXPIRED',
                 error_message = 'Worker lease expired before completion.'
             WHERE attempt_id = ?`,
          )
          .run(nowIso, stale.attempt_id);

        if (!task || task.status === 'cancelled') {
          continue;
        }

        const nowMs = new Date(nowIso).getTime();
        const pastDeadline =
          task.deadline_at !== null &&
          new Date(task.deadline_at).getTime() <= nowMs;
        const nonIdempotentDispatched =
          !task.idempotent_action && stale.external_effect_dispatched === 1;

        if (nonIdempotentDispatched) {
          const errObj: TaskError = {
            code: 'NON_IDEMPOTENT_STATE_UNCERTAIN',
            message:
              'Worker died after dispatching a non-idempotent external action; automatic retry is blocked to prevent duplicate side effects.',
            retryable: false,
          };
          this.db
            .prepare(
              `UPDATE tasks SET status = 'failed', updated_at = ?, error_json = ? WHERE id = ?`,
            )
            .run(nowIso, JSON.stringify(errObj), task.id);

          this.insertEventRow({
            event_id: `evt_${crypto.randomUUID()}`,
            task_id: task.id,
            event_type: 'task.recovery_blocked_non_idempotent',
            from_status: task.status,
            to_status: 'failed',
            actor_id: 'orchestrator_recovery',
            message: errObj.message,
            metadata: { attempt_id: stale.attempt_id },
            created_at: nowIso,
          });
          failed.push(task.id);
        } else if (!pastDeadline && task.retry_count < task.max_retries) {
          const nextRetry = task.retry_count + 1;
          this.db
            .prepare(
              `UPDATE tasks
               SET status = 'queued', retry_count = ?, next_run_at = ?, updated_at = ?,
                   error_json = NULL
               WHERE id = ?`,
            )
            .run(nextRetry, nowIso, nowIso, task.id);

          this.insertEventRow({
            event_id: `evt_${crypto.randomUUID()}`,
            task_id: task.id,
            event_type: 'task.lease_recovered_requeued',
            from_status: task.status,
            to_status: 'queued',
            actor_id: 'orchestrator_recovery',
            message: `Recovered abandoned lease from attempt #${stale.attempt_number}; re-queued as retry ${nextRetry}/${task.max_retries}.`,
            metadata: {
              abandoned_attempt_id: stale.attempt_id,
              retry_count: nextRetry,
            },
            created_at: nowIso,
          });
          requeued.push(task.id);
        } else {
          const errObj: TaskError = {
            code: pastDeadline
              ? 'TASK_DEADLINE_EXCEEDED'
              : 'WORKER_LEASE_ABANDONED',
            message: pastDeadline
              ? 'Worker lease expired after task deadline.'
              : `Worker lease expired and retry budget (${task.max_retries}) is exhausted.`,
            retryable: false,
          };
          this.db
            .prepare(
              `UPDATE tasks SET status = 'failed', updated_at = ?, error_json = ? WHERE id = ?`,
            )
            .run(nowIso, JSON.stringify(errObj), task.id);

          this.insertEventRow({
            event_id: `evt_${crypto.randomUUID()}`,
            task_id: task.id,
            event_type: 'task.lease_abandoned_failed',
            from_status: task.status,
            to_status: 'failed',
            actor_id: 'orchestrator_recovery',
            message: errObj.message,
            metadata: { abandoned_attempt_id: stale.attempt_id },
            created_at: nowIso,
          });
          failed.push(task.id);
        }
      }

      this.db.exec('COMMIT');
      return {
        recovered_count: staleRows.length,
        requeued_task_ids: requeued,
        failed_task_ids: failed,
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  createSchedule(schedule: ScheduleRecord): ScheduleRecord {
    this.db
      .prepare(
        `INSERT INTO schedules (
          id, name, description, interval_seconds, next_run_at, enabled,
          task_template_json, last_task_id, last_run_at, created_by,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.id,
        schedule.name,
        schedule.description,
        schedule.interval_seconds,
        schedule.next_run_at,
        schedule.enabled ? 1 : 0,
        JSON.stringify(schedule.task_template),
        schedule.last_task_id,
        schedule.last_run_at,
        schedule.created_by,
        schedule.created_at,
        schedule.updated_at,
      );
    return this.getSchedule(schedule.id)!;
  }

  getSchedule(scheduleId: string): ScheduleRecord | null {
    const row = this.db
      .prepare('SELECT * FROM schedules WHERE id = ?')
      .get(scheduleId) as unknown as RawScheduleRow | undefined;
    return row ? hydrateScheduleRow(row) : null;
  }

  listSchedules(): ScheduleRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM schedules ORDER BY created_at DESC')
      .all() as unknown as RawScheduleRow[];
    return rows.map(hydrateScheduleRow);
  }

  listDueSchedules(nowIso: string): ScheduleRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC',
      )
      .all(nowIso) as unknown as RawScheduleRow[];
    return rows.map(hydrateScheduleRow);
  }

  updateScheduleState(params: {
    scheduleId: string;
    enabled?: boolean;
    nextRunAt?: string;
    lastTaskId?: string | null;
    lastRunAt?: string | null;
    updatedAt: string;
  }): ScheduleRecord | null {
    const existing = this.getSchedule(params.scheduleId);
    if (!existing) return null;

    const enabled = params.enabled ?? existing.enabled;
    const nextRunAt = params.nextRunAt ?? existing.next_run_at;
    const lastTaskId =
      params.lastTaskId !== undefined ? params.lastTaskId : existing.last_task_id;
    const lastRunAt =
      params.lastRunAt !== undefined ? params.lastRunAt : existing.last_run_at;

    this.db
      .prepare(
        `UPDATE schedules
         SET enabled = ?, next_run_at = ?, last_task_id = ?, last_run_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        enabled ? 1 : 0,
        nextRunAt,
        lastTaskId,
        lastRunAt,
        params.updatedAt,
        params.scheduleId,
      );

    return this.getSchedule(params.scheduleId);
  }

  // ApprovalStore persistence
  get(approvalId: string): ApprovalRecord | null {
    const row = this.db
      .prepare('SELECT * FROM approvals WHERE id = ?')
      .get(approvalId) as unknown as RawApprovalRow | undefined;
    return row ? hydrateApprovalRow(row) : null;
  }

  save(record: ApprovalRecord): void {
    const check = validateApproval(toContractApproval(record));
    if (!check.valid) {
      throw new Error(
        `Refusing to persist invalid approval: ${check.errors.map((e) => e.message).join('; ')}`,
      );
    }

    this.db
      .prepare(
        `INSERT INTO approvals (
          id, task_id, action, requested_by, requested_at, status,
          reviewed_by, reviewed_at, reason, scope_json, environment,
          consumed_at, consumed_for_task_id, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          reviewed_by = excluded.reviewed_by,
          reviewed_at = excluded.reviewed_at,
          reason = excluded.reason,
          scope_json = excluded.scope_json,
          consumed_at = excluded.consumed_at,
          consumed_for_task_id = excluded.consumed_for_task_id`,
      )
      .run(
        record.id,
        record.task_id,
        record.action,
        record.requested_by,
        record.requested_at,
        record.status,
        record.reviewed_by,
        record.reviewed_at,
        record.reason,
        JSON.stringify(record.scope),
        record.environment,
        record.consumed_at,
        record.consumed_for_task_id,
        record.schema_version ?? '1.0.0',
      );
  }

  listAll(): ApprovalRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM approvals ORDER BY requested_at DESC')
      .all() as unknown as RawApprovalRow[];
    return rows.map(hydrateApprovalRow);
  }

  // Stage 4 Agent Execution Jobs & Structured Logs
  private insertAgentExecutionLogRow(log: AgentExecutionLogRecord): void {
    this.db
      .prepare(
        `INSERT INTO agent_execution_logs (
          log_id, job_id, task_id, agent_id, requested_action,
          permission_decision, policy_reason_code, approval_id,
          outcome, summary, details_json, secrets_redacted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        log.log_id,
        log.job_id,
        log.task_id,
        log.agent_id,
        log.requested_action,
        log.permission_decision,
        log.policy_reason_code,
        log.approval_id,
        log.outcome,
        log.summary,
        JSON.stringify(log.details),
        log.secrets_redacted ? 1 : 0,
        log.created_at,
      );
  }

  createAgentExecutionJob(params: {
    job: AgentExecutionJobRecord;
    initialLog: AgentExecutionLogRecord;
  }): {
    created: boolean;
    job: AgentExecutionJobRecord;
  } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (params.job.idempotency_key) {
        const existingRow = this.db
          .prepare('SELECT * FROM agent_execution_jobs WHERE idempotency_key = ?')
          .get(params.job.idempotency_key) as unknown as RawAgentJobRow | undefined;
        if (existingRow) {
          this.db.exec('COMMIT');
          return { created: false, job: hydrateAgentJobRow(existingRow) };
        }
      }

      this.db
        .prepare(
          `INSERT INTO agent_execution_jobs (
            job_id, task_id, attempt_id, agent_id, agent_department, agent_role,
            sandbox_provider, isolation_level, status, requested_action, resource_id,
            environment, permission_decision, policy_reason_code, approval_id,
            tool_ids_json, declared_scopes_json, allowed_paths_json, network_mode,
            network_allowlist_json, browser_mode, input_json, idempotency_key,
            idempotent_action, retry_count, max_retries, timeout_ms, next_run_at,
            result_json, error_json, created_at, started_at, finished_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          params.job.job_id,
          params.job.task_id,
          params.job.attempt_id,
          params.job.agent_id,
          params.job.agent_department,
          params.job.agent_role,
          params.job.sandbox_provider,
          params.job.isolation_level,
          params.job.status,
          params.job.requested_action,
          params.job.resource_id,
          params.job.environment,
          params.job.permission_decision,
          params.job.policy_reason_code,
          params.job.approval_id,
          JSON.stringify(params.job.tool_ids),
          JSON.stringify(params.job.declared_scopes),
          JSON.stringify(params.job.allowed_paths),
          params.job.network_mode,
          JSON.stringify(params.job.network_allowlist),
          params.job.browser_mode,
          JSON.stringify(params.job.input),
          params.job.idempotency_key,
          params.job.idempotent_action ? 1 : 0,
          params.job.retry_count,
          params.job.max_retries,
          params.job.timeout_ms,
          params.job.next_run_at,
          params.job.result ? JSON.stringify(params.job.result) : null,
          params.job.error ? JSON.stringify(params.job.error) : null,
          params.job.created_at,
          params.job.started_at,
          params.job.finished_at,
          params.job.updated_at,
        );

      this.insertAgentExecutionLogRow(params.initialLog);
      this.db.exec('COMMIT');

      const createdRow = this.db
        .prepare('SELECT * FROM agent_execution_jobs WHERE job_id = ?')
        .get(params.job.job_id) as unknown as RawAgentJobRow;
      return { created: true, job: hydrateAgentJobRow(createdRow) };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getAgentExecutionJob(jobId: string): AgentExecutionJobRecord | null {
    const row = this.db
      .prepare('SELECT * FROM agent_execution_jobs WHERE job_id = ?')
      .get(jobId) as unknown as RawAgentJobRow | undefined;
    return row ? hydrateAgentJobRow(row) : null;
  }

  getAgentExecutionJobByIdempotencyKey(
    key: string,
  ): AgentExecutionJobRecord | null {
    const row = this.db
      .prepare('SELECT * FROM agent_execution_jobs WHERE idempotency_key = ?')
      .get(key) as unknown as RawAgentJobRow | undefined;
    return row ? hydrateAgentJobRow(row) : null;
  }

  listAgentExecutionJobs(filter?: {
    status?: AgentExecutionJobStatus;
    taskId?: string;
    agentId?: string;
    limit?: number;
  }): AgentExecutionJobRecord[] {
    const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 500);
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter?.taskId) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter?.agentId) {
      clauses.push('agent_id = ?');
      params.push(filter.agentId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT * FROM agent_execution_jobs ${where} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params) as unknown as RawAgentJobRow[];
    return rows.map(hydrateAgentJobRow);
  }

  claimAgentExecutionJob(params: {
    jobId?: string;
    nowIso: string;
  }): AgentExecutionJobRecord | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const candidate = params.jobId
        ? (this.db
            .prepare(
              `SELECT * FROM agent_execution_jobs
               WHERE job_id = ? AND status = 'queued'`,
            )
            .get(params.jobId) as unknown as RawAgentJobRow | undefined)
        : (this.db
            .prepare(
              `SELECT * FROM agent_execution_jobs
               WHERE status = 'queued' AND next_run_at <= ?
               ORDER BY created_at ASC
               LIMIT 1`,
            )
            .get(params.nowIso) as unknown as RawAgentJobRow | undefined);

      if (!candidate) {
        this.db.exec('COMMIT');
        return null;
      }

      const info = this.db
        .prepare(
          `UPDATE agent_execution_jobs
           SET status = 'running',
               started_at = COALESCE(started_at, ?),
               updated_at = ?
           WHERE job_id = ? AND status = 'queued'`,
        )
        .run(params.nowIso, params.nowIso, candidate.job_id);

      if (info.changes === 0) {
        this.db.exec('COMMIT');
        return null;
      }

      const updated = this.db
        .prepare('SELECT * FROM agent_execution_jobs WHERE job_id = ?')
        .get(candidate.job_id) as unknown as RawAgentJobRow;
      this.db.exec('COMMIT');
      return hydrateAgentJobRow(updated);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  completeAgentExecutionJob(params: {
    jobId: string;
    status: 'completed' | 'failed' | 'queued' | 'cancelled';
    nowIso: string;
    result?: Record<string, unknown> | null;
    error?: AgentExecutionError | null;
    retryCount?: number;
    nextRunAt?: string;
    log: AgentExecutionLogRecord;
  }): AgentExecutionJobRecord | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getAgentExecutionJob(params.jobId);
      if (!existing) {
        this.db.exec('ROLLBACK');
        return null;
      }

      // Preserve external cancellation if job was cancelled while running.
      const effectiveStatus =
        existing.status === 'cancelled' ? 'cancelled' : params.status;
      const isTerminal =
        effectiveStatus === 'completed' ||
        effectiveStatus === 'failed' ||
        effectiveStatus === 'cancelled';

      if (existing.status !== 'cancelled') {
        this.db
          .prepare(
            `UPDATE agent_execution_jobs
             SET status = ?,
                 result_json = ?,
                 error_json = ?,
                 retry_count = ?,
                 next_run_at = ?,
                 finished_at = ?,
                 updated_at = ?
             WHERE job_id = ?`,
          )
          .run(
            effectiveStatus,
            params.result !== undefined
              ? params.result
                ? JSON.stringify(params.result)
                : null
              : existing.result
                ? JSON.stringify(existing.result)
                : null,
            params.error !== undefined
              ? params.error
                ? JSON.stringify(params.error)
                : null
              : existing.error
                ? JSON.stringify(existing.error)
                : null,
            params.retryCount ?? existing.retry_count,
            params.nextRunAt ?? existing.next_run_at,
            isTerminal ? params.nowIso : null,
            params.nowIso,
            params.jobId,
          );
      }

      this.insertAgentExecutionLogRow(params.log);
      this.db.exec('COMMIT');
      return this.getAgentExecutionJob(params.jobId);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  cancelAgentExecutionJob(params: {
    jobId: string;
    nowIso: string;
    error: AgentExecutionError;
    log: AgentExecutionLogRecord;
  }): AgentExecutionJobRecord | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getAgentExecutionJob(params.jobId);
      if (!existing) {
        this.db.exec('ROLLBACK');
        return null;
      }
      if (['completed', 'failed', 'cancelled'].includes(existing.status)) {
        this.db.exec('ROLLBACK');
        return existing;
      }

      this.db
        .prepare(
          `UPDATE agent_execution_jobs
           SET status = 'cancelled',
               error_json = ?,
               finished_at = ?,
               updated_at = ?
           WHERE job_id = ?`,
        )
        .run(
          JSON.stringify(params.error),
          params.nowIso,
          params.nowIso,
          params.jobId,
        );

      this.insertAgentExecutionLogRow(params.log);
      this.db.exec('COMMIT');
      return this.getAgentExecutionJob(params.jobId);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  recoverInterruptedAgentExecutionJobs(
    nowIso: string,
  ): AgentExecutionRecoveryReport {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const interrupted = this.db
        .prepare(
          `SELECT * FROM agent_execution_jobs WHERE status = 'running' ORDER BY created_at ASC`,
        )
        .all() as unknown as RawAgentJobRow[];

      const requeued: string[] = [];
      const failed: string[] = [];

      for (const row of interrupted) {
        const job = hydrateAgentJobRow(row);
        if (job.idempotent_action && job.retry_count < job.max_retries) {
          const nextRetry = job.retry_count + 1;
          this.db
            .prepare(
              `UPDATE agent_execution_jobs
               SET status = 'queued',
                   retry_count = ?,
                   next_run_at = ?,
                   updated_at = ?
               WHERE job_id = ?`,
            )
            .run(nextRetry, nowIso, nowIso, job.job_id);

          this.insertAgentExecutionLogRow({
            log_id: `elog_${crypto.randomUUID()}`,
            job_id: job.job_id,
            task_id: job.task_id,
            agent_id: job.agent_id,
            requested_action: job.requested_action,
            permission_decision: job.permission_decision,
            policy_reason_code: job.policy_reason_code,
            approval_id: job.approval_id,
            outcome: 'queued',
            summary: `Recovered interrupted execution job after restart; re-queued as retry ${nextRetry}/${job.max_retries}.`,
            details: {
              recovery: true,
              retry_count: nextRetry,
              max_retries: job.max_retries,
            },
            secrets_redacted: false,
            created_at: nowIso,
          });
          requeued.push(job.job_id);
        } else {
          const reason = !job.idempotent_action
            ? 'Process interrupted during non-idempotent sandboxed job; automatic retry blocked.'
            : `Process interrupted and retry limit (${job.max_retries}) exhausted.`;
          const errObj: AgentExecutionError = {
            code: !job.idempotent_action
              ? 'INTERRUPTED_NON_IDEMPOTENT_JOB'
              : 'INTERRUPTED_JOB_RETRY_EXHAUSTED',
            message: reason,
            retryable: false,
          };
          this.db
            .prepare(
              `UPDATE agent_execution_jobs
               SET status = 'failed',
                   error_json = ?,
                   finished_at = ?,
                   updated_at = ?
               WHERE job_id = ?`,
            )
            .run(JSON.stringify(errObj), nowIso, nowIso, job.job_id);

          this.insertAgentExecutionLogRow({
            log_id: `elog_${crypto.randomUUID()}`,
            job_id: job.job_id,
            task_id: job.task_id,
            agent_id: job.agent_id,
            requested_action: job.requested_action,
            permission_decision: job.permission_decision,
            policy_reason_code: job.policy_reason_code,
            approval_id: job.approval_id,
            outcome: 'failed',
            summary: reason,
            details: {
              recovery: true,
              error_code: errObj.code,
            },
            secrets_redacted: false,
            created_at: nowIso,
          });
          failed.push(job.job_id);
        }
      }

      this.db.exec('COMMIT');
      return {
        recovered_count: interrupted.length,
        requeued_job_ids: requeued,
        failed_job_ids: failed,
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  appendAgentExecutionLog(log: AgentExecutionLogRecord): void {
    this.insertAgentExecutionLogRow(log);
  }

  listAgentExecutionLogs(filter?: {
    jobId?: string;
    taskId?: string;
    agentId?: string;
    limit?: number;
  }): AgentExecutionLogRecord[] {
    const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 500);
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.jobId) {
      clauses.push('job_id = ?');
      params.push(filter.jobId);
    }
    if (filter?.taskId) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter?.agentId) {
      clauses.push('agent_id = ?');
      params.push(filter.agentId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT * FROM agent_execution_logs ${where} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params) as unknown as RawAgentExecutionLogRow[];
    return rows.map(hydrateAgentExecutionLogRow);
  }

  // -------------------- Stage 4.5 Managed Agents --------------------

  saveManagedAgent(record: ManagedAgentRecord): ManagedAgentRecord {
    this.db
      .prepare(
        `INSERT INTO managed_agents (
          id, name, department, role, description, status, enabled,
          permitted_autonomy_level, allowed_tool_ids_json, preferred_model_ids_json,
          backup_model_ids_json, max_concurrent_jobs, timeout_ms, allowed_paths_json,
          network_mode, last_health_status, created_by, created_at, updated_at, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          department = excluded.department,
          role = excluded.role,
          description = excluded.description,
          status = excluded.status,
          enabled = excluded.enabled,
          permitted_autonomy_level = excluded.permitted_autonomy_level,
          allowed_tool_ids_json = excluded.allowed_tool_ids_json,
          preferred_model_ids_json = excluded.preferred_model_ids_json,
          backup_model_ids_json = excluded.backup_model_ids_json,
          max_concurrent_jobs = excluded.max_concurrent_jobs,
          timeout_ms = excluded.timeout_ms,
          allowed_paths_json = excluded.allowed_paths_json,
          network_mode = excluded.network_mode,
          last_health_status = excluded.last_health_status,
          updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.name,
        record.department,
        record.role,
        record.description,
        record.status,
        record.enabled ? 1 : 0,
        record.permitted_autonomy_level,
        JSON.stringify(record.allowed_tool_ids),
        JSON.stringify(record.preferred_model_ids),
        JSON.stringify(record.backup_model_ids),
        record.max_concurrent_jobs,
        record.timeout_ms,
        JSON.stringify(record.allowed_paths),
        record.network_mode,
        record.last_health_status,
        record.created_by,
        record.created_at,
        record.updated_at,
        record.schema_version,
      );
    return this.getManagedAgent(record.id)!;
  }

  getManagedAgent(agentId: string): ManagedAgentRecord | null {
    const row = this.db
      .prepare('SELECT * FROM managed_agents WHERE id = ?')
      .get(agentId) as unknown as RawManagedAgentRow | undefined;
    return row ? hydrateManagedAgentRow(row) : null;
  }

  listManagedAgents(filter?: {
    department?: ManagedAgentDepartment;
    status?: ManagedAgentStatus;
    limit?: number;
    offset?: number;
  }): { items: ManagedAgentRecord[]; total: number } {
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 250);
    const offset = Math.max(filter?.offset ?? 0, 0);
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.department) {
      clauses.push('department = ?');
      params.push(filter.department);
    }
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM managed_agents ${where}`)
      .get(...params) as { cnt: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM managed_agents ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as RawManagedAgentRow[];
    return {
      items: rows.map(hydrateManagedAgentRow),
      total: countRow.cnt,
    };
  }

  deleteManagedAgent(agentId: string): boolean {
    const info = this.db
      .prepare('DELETE FROM managed_agents WHERE id = ?')
      .run(agentId);
    return info.changes > 0;
  }

  // -------------------- Stage 4.5 Managed Models --------------------

  saveManagedModel(record: ManagedModelRecord): ManagedModelRecord {
    this.db
      .prepare(
        `INSERT INTO managed_models (
          model_id, model_name, model_family, model_version, source, repo_id, revision,
          local_model_path, controlled_runtime_endpoint, runtime_type, compatibility_status,
          modality, capabilities_json, hardware_requirements_json, quantization, context_length,
          size_mb, format, install_status, verified_on_disk, is_default, is_backup, enabled,
          availability, license_json, node_id, last_verified_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(model_id) DO UPDATE SET
          model_name = excluded.model_name,
          model_family = excluded.model_family,
          model_version = excluded.model_version,
          source = excluded.source,
          repo_id = excluded.repo_id,
          revision = excluded.revision,
          local_model_path = excluded.local_model_path,
          controlled_runtime_endpoint = excluded.controlled_runtime_endpoint,
          runtime_type = excluded.runtime_type,
          compatibility_status = excluded.compatibility_status,
          modality = excluded.modality,
          capabilities_json = excluded.capabilities_json,
          hardware_requirements_json = excluded.hardware_requirements_json,
          quantization = excluded.quantization,
          context_length = excluded.context_length,
          size_mb = excluded.size_mb,
          format = excluded.format,
          install_status = excluded.install_status,
          verified_on_disk = excluded.verified_on_disk,
          is_default = excluded.is_default,
          is_backup = excluded.is_backup,
          enabled = excluded.enabled,
          availability = excluded.availability,
          license_json = excluded.license_json,
          node_id = excluded.node_id,
          last_verified_at = excluded.last_verified_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at`,
      )
      .run(
        record.model_id,
        record.model_name,
        record.model_family,
        record.model_version,
        record.source,
        record.repo_id,
        record.revision,
        record.local_model_path,
        record.controlled_runtime_endpoint,
        record.runtime_type,
        record.compatibility_status,
        record.modality,
        JSON.stringify(record.capabilities),
        JSON.stringify(record.hardware_requirements),
        record.quantization,
        record.context_length,
        record.size_mb,
        record.format,
        record.install_status,
        record.verified_on_disk ? 1 : 0,
        record.is_default ? 1 : 0,
        record.is_backup ? 1 : 0,
        record.enabled ? 1 : 0,
        record.availability,
        JSON.stringify(record.license),
        record.node_id,
        record.last_verified_at,
        record.last_error,
        record.created_at,
        record.updated_at,
      );
    return this.getManagedModel(record.model_id)!;
  }

  getManagedModel(modelId: string): ManagedModelRecord | null {
    const row = this.db
      .prepare('SELECT * FROM managed_models WHERE model_id = ?')
      .get(modelId) as unknown as RawManagedModelRow | undefined;
    return row ? hydrateManagedModelRow(row) : null;
  }

  listManagedModels(filter?: {
    runtimeType?: string;
    source?: ManagedModelSource;
    limit?: number;
    offset?: number;
  }): { items: ManagedModelRecord[]; total: number } {
    const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 250);
    const offset = Math.max(filter?.offset ?? 0, 0);
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.runtimeType) {
      clauses.push('runtime_type = ?');
      params.push(filter.runtimeType);
    }
    if (filter?.source) {
      clauses.push('source = ?');
      params.push(filter.source);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM managed_models ${where}`)
      .get(...params) as { cnt: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM managed_models ${where} ORDER BY is_default DESC, is_backup DESC, created_at ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as RawManagedModelRow[];

    return {
      items: rows.map(hydrateManagedModelRow),
      total: countRow.cnt,
    };
  }

  setManagedModelRole(
    modelId: string,
    role: 'default' | 'backup',
    updatedAt: string,
  ): ManagedModelRecord | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getManagedModel(modelId);
      if (!existing) {
        this.db.exec('ROLLBACK');
        return null;
      }
      if (role === 'default') {
        this.db
          .prepare('UPDATE managed_models SET is_default = 0 WHERE is_default = 1')
          .run();
        this.db
          .prepare(
            'UPDATE managed_models SET is_default = 1, is_backup = 0, updated_at = ? WHERE model_id = ?',
          )
          .run(updatedAt, modelId);
      } else {
        this.db
          .prepare('UPDATE managed_models SET is_backup = 0 WHERE is_backup = 1')
          .run();
        this.db
          .prepare(
            'UPDATE managed_models SET is_backup = 1, is_default = 0, updated_at = ? WHERE model_id = ?',
          )
          .run(updatedAt, modelId);
      }
      this.db.exec('COMMIT');
      return this.getManagedModel(modelId);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  deleteManagedModel(modelId: string): boolean {
    const info = this.db
      .prepare('DELETE FROM managed_models WHERE model_id = ?')
      .run(modelId);
    return info.changes > 0;
  }

  // -------------------- Stage 4.5 Managed Workers --------------------

  saveManagedWorker(record: ManagedWorkerRecord): ManagedWorkerRecord {
    this.db
      .prepare(
        `INSERT INTO managed_workers (
          worker_id, name, runtime_type, node_id, base_url, requires_auth,
          auth_token_env_var, enabled, health_status, current_model_id,
          active_jobs, queue_length, latency_ms, discovered_models_json,
          last_checked_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET
          name = excluded.name,
          runtime_type = excluded.runtime_type,
          node_id = excluded.node_id,
          base_url = excluded.base_url,
          requires_auth = excluded.requires_auth,
          auth_token_env_var = excluded.auth_token_env_var,
          enabled = excluded.enabled,
          health_status = excluded.health_status,
          current_model_id = excluded.current_model_id,
          active_jobs = excluded.active_jobs,
          queue_length = excluded.queue_length,
          latency_ms = excluded.latency_ms,
          discovered_models_json = excluded.discovered_models_json,
          last_checked_at = excluded.last_checked_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at`,
      )
      .run(
        record.worker_id,
        record.name,
        record.runtime_type,
        record.node_id,
        record.base_url,
        record.requires_auth ? 1 : 0,
        record.auth_token_env_var,
        record.enabled ? 1 : 0,
        record.health_status,
        record.current_model_id,
        record.active_jobs,
        record.queue_length,
        record.latency_ms,
        JSON.stringify(record.discovered_models),
        record.last_checked_at,
        record.last_error,
        record.created_at,
        record.updated_at,
      );
    return this.getManagedWorker(record.worker_id)!;
  }

  getManagedWorker(workerId: string): ManagedWorkerRecord | null {
    const row = this.db
      .prepare('SELECT * FROM managed_workers WHERE worker_id = ?')
      .get(workerId) as unknown as RawManagedWorkerRow | undefined;
    return row ? hydrateManagedWorkerRow(row) : null;
  }

  listManagedWorkers(filter?: {
    limit?: number;
    offset?: number;
  }): { items: ManagedWorkerRecord[]; total: number } {
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 250);
    const offset = Math.max(filter?.offset ?? 0, 0);
    const countRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM managed_workers')
      .get() as { cnt: number };
    const rows = this.db
      .prepare(
        'SELECT * FROM managed_workers ORDER BY created_at DESC LIMIT ? OFFSET ?',
      )
      .all(limit, offset) as unknown as RawManagedWorkerRow[];
    return {
      items: rows.map(hydrateManagedWorkerRow),
      total: countRow.cnt,
    };
  }

  deleteManagedWorker(workerId: string): boolean {
    const info = this.db
      .prepare('DELETE FROM managed_workers WHERE worker_id = ?')
      .run(workerId);
    return info.changes > 0;
  }

  // -------------------- Stage 4.5 Managed Projects --------------------

  saveManagedProject(record: ManagedProjectRecord): ManagedProjectRecord {
    this.db
      .prepare(
        `INSERT INTO managed_projects (
          project_id, name, slug, project_type, description, domain_url,
          workspace_path, environment, deployment_status, health_status,
          assigned_agent_ids_json, recent_changes_json, recent_errors_json,
          pending_approval_id, last_deployed_at, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          name = excluded.name,
          slug = excluded.slug,
          project_type = excluded.project_type,
          description = excluded.description,
          domain_url = excluded.domain_url,
          workspace_path = excluded.workspace_path,
          environment = excluded.environment,
          deployment_status = excluded.deployment_status,
          health_status = excluded.health_status,
          assigned_agent_ids_json = excluded.assigned_agent_ids_json,
          recent_changes_json = excluded.recent_changes_json,
          recent_errors_json = excluded.recent_errors_json,
          pending_approval_id = excluded.pending_approval_id,
          last_deployed_at = excluded.last_deployed_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        record.project_id,
        record.name,
        record.slug,
        record.project_type,
        record.description,
        record.domain_url,
        record.workspace_path,
        record.environment,
        record.deployment_status,
        record.health_status,
        JSON.stringify(record.assigned_agent_ids),
        JSON.stringify(record.recent_changes),
        JSON.stringify(record.recent_errors),
        record.pending_approval_id,
        record.last_deployed_at,
        record.created_by,
        record.created_at,
        record.updated_at,
      );
    return this.getManagedProject(record.project_id)!;
  }

  getManagedProject(projectId: string): ManagedProjectRecord | null {
    const row = this.db
      .prepare('SELECT * FROM managed_projects WHERE project_id = ?')
      .get(projectId) as unknown as RawManagedProjectRow | undefined;
    return row ? hydrateManagedProjectRow(row) : null;
  }

  getManagedProjectBySlug(slug: string): ManagedProjectRecord | null {
    const row = this.db
      .prepare('SELECT * FROM managed_projects WHERE slug = ?')
      .get(slug) as unknown as RawManagedProjectRow | undefined;
    return row ? hydrateManagedProjectRow(row) : null;
  }

  listManagedProjects(filter?: {
    environment?: OrchestratedTaskRecord['environment'];
    limit?: number;
    offset?: number;
  }): { items: ManagedProjectRecord[]; total: number } {
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 250);
    const offset = Math.max(filter?.offset ?? 0, 0);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter?.environment) {
      clauses.push('environment = ?');
      params.push(filter.environment);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM managed_projects ${where}`)
      .get(...params) as { cnt: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM managed_projects ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as RawManagedProjectRow[];
    return {
      items: rows.map(hydrateManagedProjectRow),
      total: countRow.cnt,
    };
  }

  deleteManagedProject(projectId: string): boolean {
    const info = this.db
      .prepare('DELETE FROM managed_projects WHERE project_id = ?')
      .run(projectId);
    return info.changes > 0;
  }

  // -------------------- Stage 4.5 System Config KV & Backups --------------------

  getSystemConfigEntry(configKey: string): SystemConfigEntry | null {
    const row = this.db
      .prepare('SELECT * FROM system_config_kv WHERE config_key = ?')
      .get(configKey) as unknown as RawSystemConfigRow | undefined;
    return row ? hydrateSystemConfigRow(row) : null;
  }

  setSystemConfigEntry(entry: SystemConfigEntry): SystemConfigEntry {
    this.db
      .prepare(
        `INSERT INTO system_config_kv (config_key, config_value_json, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(config_key) DO UPDATE SET
           config_value_json = excluded.config_value_json,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(
        entry.config_key,
        JSON.stringify(entry.config_value),
        entry.updated_at,
        entry.updated_by,
      );
    return this.getSystemConfigEntry(entry.config_key)!;
  }

  listSystemConfigEntries(): SystemConfigEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM system_config_kv ORDER BY config_key ASC')
      .all() as unknown as RawSystemConfigRow[];
    return rows.map(hydrateSystemConfigRow);
  }

  saveSystemBackup(record: SystemBackupRecord): SystemBackupRecord {
    this.db
      .prepare(
        `INSERT INTO system_backups (
          backup_id, filename, size_bytes, sha256, summary_json,
          created_by, created_at, restored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.backup_id,
        record.filename,
        record.size_bytes,
        record.sha256,
        JSON.stringify(record.summary),
        record.created_by,
        record.created_at,
        record.restored_at,
      );
    return this.getSystemBackup(record.backup_id)!;
  }

  getSystemBackup(backupId: string): SystemBackupRecord | null {
    const row = this.db
      .prepare('SELECT * FROM system_backups WHERE backup_id = ?')
      .get(backupId) as unknown as RawSystemBackupRow | undefined;
    return row ? hydrateSystemBackupRow(row) : null;
  }

  listSystemBackups(limit = 50): SystemBackupRecord[] {
    const clamped = Math.min(Math.max(Math.round(limit), 1), 200);
    const rows = this.db
      .prepare('SELECT * FROM system_backups ORDER BY created_at DESC LIMIT ?')
      .all(clamped) as unknown as RawSystemBackupRow[];
    return rows.map(hydrateSystemBackupRow);
  }

  markSystemBackupRestored(backupId: string, restoredAt: string): void {
    this.db
      .prepare('UPDATE system_backups SET restored_at = ? WHERE backup_id = ?')
      .run(restoredAt, backupId);
  }

  exportManagementSnapshot(): Record<string, unknown> {
    return {
      schema_version: '1.0.0',
      agents: this.listManagedAgents({ limit: 250 }).items,
      models: this.listManagedModels({ limit: 250 }).items,
      workers: this.listManagedWorkers({ limit: 250 }).items,
      projects: this.listManagedProjects({ limit: 250 }).items,
      schedules: this.listSchedules(),
      config: this.listSystemConfigEntries(),
    };
  }

  restoreManagementSnapshot(snapshot: Record<string, unknown>): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const agents = Array.isArray(snapshot.agents)
        ? (snapshot.agents as ManagedAgentRecord[])
        : [];
      const models = Array.isArray(snapshot.models)
        ? (snapshot.models as ManagedModelRecord[])
        : [];
      const workers = Array.isArray(snapshot.workers)
        ? (snapshot.workers as ManagedWorkerRecord[])
        : [];
      const projects = Array.isArray(snapshot.projects)
        ? (snapshot.projects as ManagedProjectRecord[])
        : [];
      const configs = Array.isArray(snapshot.config)
        ? (snapshot.config as SystemConfigEntry[])
        : [];

      this.db.exec('DELETE FROM managed_agents');
      for (const a of agents) {
        this.saveManagedAgent(a);
      }

      this.db.exec('DELETE FROM managed_models');
      for (const m of models) {
        this.saveManagedModel(m);
      }

      this.db.exec('DELETE FROM managed_workers');
      for (const w of workers) {
        this.saveManagedWorker(w);
      }

      this.db.exec('DELETE FROM managed_projects');
      for (const p of projects) {
        this.saveManagedProject(p);
      }

      this.db.exec('DELETE FROM system_config_kv');
      for (const c of configs) {
        this.setSystemConfigEntry(c);
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
