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
