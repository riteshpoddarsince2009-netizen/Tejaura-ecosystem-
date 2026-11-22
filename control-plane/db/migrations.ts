import type { DatabaseSync } from 'node:sqlite';

export interface SchemaMigration {
  version: number;
  name: string;
  sql: string;
}

export const STAGE3_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: '001_initial_stage3_orchestration',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled')
        ),
        autonomy_level TEXT NOT NULL CHECK (
          autonomy_level IN ('L0', 'L1', 'L2', 'L3', 'L4')
        ),
        environment TEXT NOT NULL CHECK (
          environment IN ('sandbox', 'local', 'staging', 'production')
        ),
        action TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        declared_scopes_json TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 50 CHECK (priority >= 0 AND priority <= 100),
        idempotency_key TEXT UNIQUE,
        idempotent_action INTEGER NOT NULL DEFAULT 1 CHECK (idempotent_action IN (0, 1)),
        deadline_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        max_retries INTEGER NOT NULL DEFAULT 0 CHECK (max_retries >= 0),
        timeout_ms INTEGER NOT NULL DEFAULT 30000 CHECK (timeout_ms >= 100),
        next_run_at TEXT NOT NULL,
        schedule_id TEXT,
        requested_by TEXT NOT NULL,
        assigned_agent_id TEXT,
        input_json TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        approval_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        schema_version TEXT NOT NULL DEFAULT '1.0.0'
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_queue
        ON tasks (status, next_run_at, priority DESC, created_at ASC);

      CREATE TABLE IF NOT EXISTS task_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        actor_id TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_task_events_task_id
        ON task_events (task_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 10),
        next_run_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        task_template_json TEXT NOT NULL,
        last_task_id TEXT,
        last_run_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_schedules_due
        ON schedules (enabled, next_run_at ASC);

      CREATE TABLE IF NOT EXISTS execution_attempts (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
        worker_id TEXT NOT NULL,
        lease_token TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('leased', 'running', 'succeeded', 'failed', 'timed_out', 'abandoned', 'cancelled')
        ),
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        finished_at TEXT,
        error_code TEXT,
        error_message TEXT,
        runtime_type TEXT,
        model_id TEXT,
        external_effect_dispatched INTEGER NOT NULL DEFAULT 0 CHECK (external_effect_dispatched IN (0, 1)),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_attempts_task_id
        ON execution_attempts (task_id, attempt_number DESC);

      CREATE INDEX IF NOT EXISTS idx_attempts_active_leases
        ON execution_attempts (status, lease_expires_at ASC);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        action TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'approved', 'rejected', 'expired')
        ),
        reviewed_by TEXT,
        reviewed_at TEXT,
        reason TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (
          environment IN ('sandbox', 'local', 'staging', 'production')
        ),
        consumed_at TEXT,
        consumed_for_task_id TEXT,
        schema_version TEXT NOT NULL DEFAULT '1.0.0'
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_task_id
        ON approvals (task_id);

      CREATE TABLE IF NOT EXISTS idempotency_records (
        idempotency_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        effect_state TEXT NOT NULL CHECK (
          effect_state IN ('pending', 'dispatched', 'completed', 'cancelled')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 2,
    name: '002_stage4_agent_execution',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_execution_jobs (
        job_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt_id TEXT,
        agent_id TEXT NOT NULL,
        agent_department TEXT NOT NULL,
        agent_role TEXT NOT NULL,
        sandbox_provider TEXT NOT NULL,
        isolation_level TEXT NOT NULL CHECK (
          isolation_level IN ('mock_in_process', 'isolated_container')
        ),
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'completed', 'failed', 'cancelled')
        ),
        requested_action TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (
          environment IN ('sandbox', 'local', 'staging', 'production')
        ),
        permission_decision TEXT NOT NULL CHECK (
          permission_decision IN ('allow', 'deny', 'require_approval')
        ),
        policy_reason_code TEXT NOT NULL,
        approval_id TEXT,
        tool_ids_json TEXT NOT NULL,
        declared_scopes_json TEXT NOT NULL,
        allowed_paths_json TEXT NOT NULL,
        network_mode TEXT NOT NULL CHECK (
          network_mode IN ('none', 'allowlisted_endpoints')
        ),
        network_allowlist_json TEXT NOT NULL,
        browser_mode TEXT NOT NULL CHECK (
          browser_mode IN ('disabled', 'read_only_allowlisted')
        ),
        input_json TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        idempotent_action INTEGER NOT NULL DEFAULT 1 CHECK (idempotent_action IN (0, 1)),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        max_retries INTEGER NOT NULL DEFAULT 0 CHECK (max_retries >= 0),
        timeout_ms INTEGER NOT NULL DEFAULT 30000 CHECK (timeout_ms >= 100),
        next_run_at TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_jobs_queue
        ON agent_execution_jobs (status, next_run_at, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_agent_jobs_task
        ON agent_execution_jobs (task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS agent_execution_logs (
        log_id TEXT PRIMARY KEY,
        job_id TEXT,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        requested_action TEXT NOT NULL,
        permission_decision TEXT NOT NULL CHECK (
          permission_decision IN ('allow', 'deny', 'require_approval')
        ),
        policy_reason_code TEXT NOT NULL,
        approval_id TEXT,
        outcome TEXT NOT NULL CHECK (
          outcome IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'denied', 'approval_required')
        ),
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL,
        secrets_redacted INTEGER NOT NULL DEFAULT 0 CHECK (secrets_redacted IN (0, 1)),
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES agent_execution_jobs(job_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_agent_exec_logs_job
        ON agent_execution_logs (job_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_agent_exec_logs_task
        ON agent_execution_logs (task_id, created_at ASC);
    `,
  },
  {
    version: 3,
    name: '003_stage45_management_center',
    sql: `
      CREATE TABLE IF NOT EXISTS managed_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        department TEXT NOT NULL CHECK (
          department IN ('research', 'engineering', 'seo', 'design', 'content', 'analytics', 'customer_support')
        ),
        role TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('active', 'paused', 'disabled', 'retired')
        ),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        permitted_autonomy_level TEXT NOT NULL CHECK (
          permitted_autonomy_level IN ('L0', 'L1', 'L2', 'L3')
        ),
        allowed_tool_ids_json TEXT NOT NULL,
        preferred_model_ids_json TEXT NOT NULL,
        backup_model_ids_json TEXT NOT NULL,
        max_concurrent_jobs INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrent_jobs >= 1 AND max_concurrent_jobs <= 10),
        timeout_ms INTEGER NOT NULL DEFAULT 30000 CHECK (timeout_ms >= 500 AND timeout_ms <= 300000),
        allowed_paths_json TEXT NOT NULL,
        network_mode TEXT NOT NULL DEFAULT 'none' CHECK (
          network_mode IN ('none', 'allowlisted_endpoints')
        ),
        last_health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
          last_health_status IN ('healthy', 'degraded', 'offline', 'unknown')
        ),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        schema_version TEXT NOT NULL DEFAULT '1.0.0'
      );

      CREATE INDEX IF NOT EXISTS idx_managed_agents_dept
        ON managed_agents (department, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS managed_models (
        model_id TEXT PRIMARY KEY,
        model_name TEXT NOT NULL,
        model_family TEXT NOT NULL,
        model_version TEXT NOT NULL,
        source TEXT NOT NULL CHECK (
          source IN ('modelscope', 'huggingface', 'local_mirror', 'owner_archive')
        ),
        repo_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        local_model_path TEXT,
        controlled_runtime_endpoint TEXT,
        runtime_type TEXT NOT NULL,
        compatibility_status TEXT NOT NULL CHECK (
          compatibility_status IN ('verified', 'untested', 'unsupported')
        ),
        modality TEXT NOT NULL CHECK (
          modality IN ('text', 'code', 'vision', 'audio', 'multimodal')
        ),
        capabilities_json TEXT NOT NULL,
        hardware_requirements_json TEXT NOT NULL,
        quantization TEXT NOT NULL,
        context_length INTEGER NOT NULL,
        size_mb INTEGER NOT NULL DEFAULT 0 CHECK (size_mb >= 0),
        format TEXT NOT NULL DEFAULT 'safetensors',
        install_status TEXT NOT NULL DEFAULT 'not_installed' CHECK (
          install_status IN ('not_installed', 'downloading', 'installed_unverified', 'verified', 'error')
        ),
        verified_on_disk INTEGER NOT NULL DEFAULT 0 CHECK (verified_on_disk IN (0, 1)),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        is_backup INTEGER NOT NULL DEFAULT 0 CHECK (is_backup IN (0, 1)),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        availability TEXT NOT NULL DEFAULT 'unknown',
        license_json TEXT NOT NULL,
        node_id TEXT,
        last_verified_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_managed_models_runtime
        ON managed_models (runtime_type, enabled, is_default DESC);

      CREATE TABLE IF NOT EXISTS managed_workers (
        worker_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        runtime_type TEXT NOT NULL,
        node_id TEXT NOT NULL,
        base_url TEXT NOT NULL,
        requires_auth INTEGER NOT NULL DEFAULT 1 CHECK (requires_auth IN (0, 1)),
        auth_token_env_var TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
          health_status IN ('online', 'offline', 'degraded', 'unknown')
        ),
        current_model_id TEXT,
        active_jobs INTEGER NOT NULL DEFAULT 0 CHECK (active_jobs >= 0),
        queue_length INTEGER NOT NULL DEFAULT 0 CHECK (queue_length >= 0),
        latency_ms INTEGER,
        discovered_models_json TEXT NOT NULL,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_managed_workers_status
        ON managed_workers (enabled, health_status, created_at DESC);

      CREATE TABLE IF NOT EXISTS managed_projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        project_type TEXT NOT NULL CHECK (
          project_type IN ('website', 'web_app', 'api_service', 'automation')
        ),
        description TEXT NOT NULL,
        domain_url TEXT,
        workspace_path TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (
          environment IN ('sandbox', 'local', 'staging', 'production')
        ),
        deployment_status TEXT NOT NULL CHECK (
          deployment_status IN ('draft', 'pending_approval', 'deployed', 'degraded', 'failed', 'paused')
        ),
        health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
          health_status IN ('healthy', 'degraded', 'offline', 'unknown')
        ),
        assigned_agent_ids_json TEXT NOT NULL,
        recent_changes_json TEXT NOT NULL,
        recent_errors_json TEXT NOT NULL,
        pending_approval_id TEXT,
        last_deployed_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_managed_projects_env
        ON managed_projects (environment, deployment_status, created_at DESC);

      CREATE TABLE IF NOT EXISTS system_config_kv (
        config_key TEXT PRIMARY KEY,
        config_value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_backups (
        backup_id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restored_at TEXT
      );
    `,
  },
];

export interface AppliedMigrationRecord {
  version: number;
  name: string;
  applied_at: string;
}

export function applyStage3Migrations(
  db: DatabaseSync,
  nowIso: string = new Date().toISOString(),
): AppliedMigrationRecord[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC')
    .all() as unknown as AppliedMigrationRecord[];

  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  for (const migration of STAGE3_MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, nowIso);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC')
    .all() as unknown as AppliedMigrationRecord[];
}
