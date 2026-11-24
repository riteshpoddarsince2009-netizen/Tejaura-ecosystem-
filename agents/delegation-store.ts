import { DatabaseSync } from 'node:sqlite';

import {
  applyStage3Migrations,
  type AppliedMigrationRecord,
} from '../control-plane/db/index.ts';
import {
  DELEGATION_TASK_STATUSES,
  type DelegationProjectRecord,
  type DelegationStore,
  type DelegationTaskEventRecord,
  type DelegationTaskRecord,
  type DelegationTaskStatus,
  type DepartmentAgentStateRecord,
  type ExecutionAlertRecord,
  type WorkerHeartbeatRecord,
} from './delegation-types.ts';

interface RawTaskRow {
  task_id: string;
  project_id: string;
  parent_task_id: string | null;
  root_task_id: string;
  agent_id: string;
  department: DelegationTaskRecord['department'];
  status: DelegationTaskStatus;
  action: string;
  resource_id: string;
  environment: DelegationTaskRecord['environment'];
  title: string;
  description: string;
  input_json: string;
  output_json: string | null;
  error_json: string | null;
  risk_level: DelegationTaskRecord['risk_level'];
  approval_id: string | null;
  approval_required: number;
  depth: number;
  max_depth: number;
  retry_count: number;
  max_retries: number;
  timeout_ms: number;
  idempotency_key: string | null;
  dependencies_json: string;
  child_task_ids_json: string;
  correlation_id: string;
  cancellation_requested: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RawProjectRow {
  project_id: string;
  name: string;
  objective: string;
  context_json: string;
  allowed_agent_ids_json: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

interface RawEventRow {
  event_id: string;
  task_id: string;
  event_type: string;
  from_status: DelegationTaskStatus | null;
  to_status: DelegationTaskStatus | null;
  actor_id: string;
  message: string;
  metadata_json: string;
  created_at: string;
}

interface RawAgentStateRow {
  agent_id: string;
  status: DepartmentAgentStateRecord['status'];
  health: DepartmentAgentStateRecord['health'];
  current_task_id: string | null;
  tasks_completed: number;
  tasks_failed: number;
  last_heartbeat_at: string | null;
  updated_at: string;
}

interface RawHeartbeatRow {
  worker_id: string;
  runtime_type: string;
  endpoint: string;
  health: WorkerHeartbeatRecord['health'];
  active_jobs: number;
  queue_length: number;
  latency_ms: number | null;
  models_json: string;
  last_error: string | null;
  last_heartbeat_at: string;
  updated_at: string;
}

interface RawAlertRow {
  alert_id: string;
  severity: ExecutionAlertRecord['severity'];
  code: string;
  message: string;
  task_id: string | null;
  agent_id: string | null;
  worker_id: string | null;
  created_at: string;
  acknowledged_at: string | null;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToTask(row: RawTaskRow): DelegationTaskRecord {
  return {
    task_id: row.task_id,
    project_id: row.project_id,
    parent_task_id: row.parent_task_id,
    root_task_id: row.root_task_id,
    agent_id: row.agent_id,
    department: row.department,
    status: row.status,
    action: row.action,
    resource_id: row.resource_id,
    environment: row.environment,
    title: row.title,
    description: row.description,
    input: parseJson(row.input_json, {}),
    output: row.output_json ? parseJson(row.output_json, {}) : null,
    error: row.error_json
      ? parseJson(row.error_json, { code: 'UNKNOWN', message: '', retryable: false })
      : null,
    risk_level: row.risk_level,
    approval_id: row.approval_id,
    approval_required: row.approval_required === 1,
    depth: row.depth,
    max_depth: row.max_depth,
    retry_count: row.retry_count,
    max_retries: row.max_retries,
    timeout_ms: row.timeout_ms,
    idempotency_key: row.idempotency_key,
    dependencies: parseJson(row.dependencies_json, []),
    child_task_ids: parseJson(row.child_task_ids_json, []),
    correlation_id: row.correlation_id,
    cancellation_requested: row.cancellation_requested === 1,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToProject(row: RawProjectRow): DelegationProjectRecord {
  return {
    project_id: row.project_id,
    name: row.name,
    objective: row.objective,
    context: parseJson(row.context_json, {}),
    allowed_agent_ids: parseJson(row.allowed_agent_ids_json, []),
    owner_id: row.owner_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToEvent(row: RawEventRow): DelegationTaskEventRecord {
  return {
    event_id: row.event_id,
    task_id: row.task_id,
    event_type: row.event_type,
    from_status: row.from_status,
    to_status: row.to_status,
    actor_id: row.actor_id,
    message: row.message,
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
  };
}

export class SqliteDelegationStore implements DelegationStore {
  private readonly db: DatabaseSync;

  constructor(options: { dbPath: string }) {
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    applyStage3Migrations(this.db);
  }

  getAppliedMigrations(): AppliedMigrationRecord[] {
    return this.db
      .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC')
      .all() as unknown as AppliedMigrationRecord[];
  }

  close(): void {
    this.db.close();
  }

  seedDepartmentAgentState(agentIds: readonly string[], nowIso: string): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO department_agent_state
        (agent_id, status, health, current_task_id, tasks_completed, tasks_failed, last_heartbeat_at, updated_at)
       VALUES (?, 'active', 'unknown', NULL, 0, 0, NULL, ?)`,
    );
    for (const agentId of agentIds) {
      stmt.run(agentId, nowIso);
    }
  }

  getDepartmentAgentState(agentId: string): DepartmentAgentStateRecord | null {
    const row = this.db
      .prepare('SELECT * FROM department_agent_state WHERE agent_id = ?')
      .get(agentId) as unknown as RawAgentStateRow | undefined;
    return row ? { ...row } : null;
  }

  listDepartmentAgentStates(): DepartmentAgentStateRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM department_agent_state ORDER BY agent_id ASC')
        .all() as unknown as RawAgentStateRow[]
    ).map((row) => ({ ...row }));
  }

  updateDepartmentAgentState(params: {
    agentId: string;
    status?: DepartmentAgentStateRecord['status'];
    health?: DepartmentAgentStateRecord['health'];
    currentTaskId?: string | null;
    incrementCompleted?: boolean;
    incrementFailed?: boolean;
    lastHeartbeatAt?: string | null;
    updatedAt: string;
  }): DepartmentAgentStateRecord | null {
    const existing = this.getDepartmentAgentState(params.agentId);
    if (!existing) {
      return null;
    }
    const next: DepartmentAgentStateRecord = {
      ...existing,
      status: params.status ?? existing.status,
      health: params.health ?? existing.health,
      current_task_id:
        params.currentTaskId === undefined
          ? existing.current_task_id
          : params.currentTaskId,
      tasks_completed:
        existing.tasks_completed + (params.incrementCompleted ? 1 : 0),
      tasks_failed: existing.tasks_failed + (params.incrementFailed ? 1 : 0),
      last_heartbeat_at:
        params.lastHeartbeatAt === undefined
          ? existing.last_heartbeat_at
          : params.lastHeartbeatAt,
      updated_at: params.updatedAt,
    };
    this.db
      .prepare(
        `UPDATE department_agent_state
         SET status = ?, health = ?, current_task_id = ?, tasks_completed = ?,
             tasks_failed = ?, last_heartbeat_at = ?, updated_at = ?
         WHERE agent_id = ?`,
      )
      .run(
        next.status,
        next.health,
        next.current_task_id,
        next.tasks_completed,
        next.tasks_failed,
        next.last_heartbeat_at,
        next.updated_at,
        params.agentId,
      );
    return next;
  }

  createProject(project: DelegationProjectRecord): DelegationProjectRecord {
    this.db
      .prepare(
        `INSERT INTO delegation_projects
          (project_id, name, objective, context_json, allowed_agent_ids_json, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.project_id,
        project.name,
        project.objective,
        JSON.stringify(project.context),
        JSON.stringify(project.allowed_agent_ids),
        project.owner_id,
        project.created_at,
        project.updated_at,
      );
    return project;
  }

  getProject(projectId: string): DelegationProjectRecord | null {
    const row = this.db
      .prepare('SELECT * FROM delegation_projects WHERE project_id = ?')
      .get(projectId) as unknown as RawProjectRow | undefined;
    return row ? rowToProject(row) : null;
  }

  listProjects(limit = 50): DelegationProjectRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM delegation_projects ORDER BY created_at DESC LIMIT ?')
        .all(Math.max(1, Math.min(200, limit))) as unknown as RawProjectRow[]
    ).map(rowToProject);
  }

  createTask(params: {
    task: DelegationTaskRecord;
    event: DelegationTaskEventRecord;
  }): { created: boolean; task: DelegationTaskRecord } {
    if (params.task.idempotency_key) {
      const existing = this.getTaskByIdempotencyKey(params.task.idempotency_key);
      if (existing) {
        return { created: false, task: existing };
      }
    }

    const t = params.task;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO delegation_tasks
            (task_id, project_id, parent_task_id, root_task_id, agent_id, department, status,
             action, resource_id, environment, title, description, input_json, output_json,
             error_json, risk_level, approval_id, approval_required, depth, max_depth,
             retry_count, max_retries, timeout_ms, idempotency_key, dependencies_json,
             child_task_ids_json, correlation_id, cancellation_requested, started_at,
             finished_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          t.task_id,
          t.project_id,
          t.parent_task_id,
          t.root_task_id,
          t.agent_id,
          t.department,
          t.status,
          t.action,
          t.resource_id,
          t.environment,
          t.title,
          t.description,
          JSON.stringify(t.input),
          t.output ? JSON.stringify(t.output) : null,
          t.error ? JSON.stringify(t.error) : null,
          t.risk_level,
          t.approval_id,
          t.approval_required ? 1 : 0,
          t.depth,
          t.max_depth,
          t.retry_count,
          t.max_retries,
          t.timeout_ms,
          t.idempotency_key,
          JSON.stringify(t.dependencies),
          JSON.stringify(t.child_task_ids),
          t.correlation_id,
          t.cancellation_requested ? 1 : 0,
          t.started_at,
          t.finished_at,
          t.created_at,
          t.updated_at,
        );
      this.insertEvent(params.event);
      this.db.exec('COMMIT');
      return { created: true, task: t };
    } catch (err) {
      this.db.exec('ROLLBACK');
      if (t.idempotency_key) {
        const existing = this.getTaskByIdempotencyKey(t.idempotency_key);
        if (existing) {
          return { created: false, task: existing };
        }
      }
      throw err;
    }
  }

  getTask(taskId: string): DelegationTaskRecord | null {
    const row = this.db
      .prepare('SELECT * FROM delegation_tasks WHERE task_id = ?')
      .get(taskId) as unknown as RawTaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  getTaskByIdempotencyKey(key: string): DelegationTaskRecord | null {
    const row = this.db
      .prepare('SELECT * FROM delegation_tasks WHERE idempotency_key = ?')
      .get(key) as unknown as RawTaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(filter?: {
    projectId?: string;
    parentTaskId?: string | null;
    status?: DelegationTaskStatus;
    agentId?: string;
    limit?: number;
  }): DelegationTaskRecord[] {
    const clauses: string[] = [];
    const values: Array<string | number | null> = [];
    if (filter?.projectId) {
      clauses.push('project_id = ?');
      values.push(filter.projectId);
    }
    if (filter?.parentTaskId !== undefined) {
      if (filter.parentTaskId === null) {
        clauses.push('parent_task_id IS NULL');
      } else {
        clauses.push('parent_task_id = ?');
        values.push(filter.parentTaskId);
      }
    }
    if (filter?.status) {
      clauses.push('status = ?');
      values.push(filter.status);
    }
    if (filter?.agentId) {
      clauses.push('agent_id = ?');
      values.push(filter.agentId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(500, filter?.limit ?? 100));
    const rows = this.db
      .prepare(
        `SELECT * FROM delegation_tasks ${where} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...values, limit) as unknown as RawTaskRow[];
    return rows.map(rowToTask);
  }

  listChildren(parentTaskId: string): DelegationTaskRecord[] {
    return this.listTasks({ parentTaskId, limit: 500 });
  }

  claimNextQueuedTask(nowIso: string): DelegationTaskRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM delegation_tasks
         WHERE status = 'QUEUED' AND cancellation_requested = 0
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as unknown as RawTaskRow | undefined;
    if (!row) {
      return null;
    }
    return this.claimTask(row.task_id, nowIso);
  }

  claimTask(taskId: string, nowIso: string): DelegationTaskRecord | null {
    const result = this.db
      .prepare(
        `UPDATE delegation_tasks
         SET status = 'ASSIGNED', started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE task_id = ? AND status = 'QUEUED' AND cancellation_requested = 0`,
      )
      .run(nowIso, nowIso, taskId);
    if (Number(result.changes) !== 1) {
      return null;
    }
    return this.getTask(taskId);
  }

  updateTask(params: {
    taskId: string;
    status?: DelegationTaskStatus;
    output?: Record<string, unknown> | null;
    error?: DelegationTaskRecord['error'];
    approvalId?: string | null;
    approvalRequired?: boolean;
    retryCount?: number;
    dependencies?: string[];
    childTaskIds?: string[];
    cancellationRequested?: boolean;
    startedAt?: string | null;
    finishedAt?: string | null;
    updatedAt: string;
    event: DelegationTaskEventRecord;
  }): DelegationTaskRecord | null {
    const sets: string[] = ['updated_at = ?'];
    const values: Array<string | number | null> = [params.updatedAt];
    if (params.status !== undefined) {
      sets.push('status = ?');
      values.push(params.status);
    }
    if (params.output !== undefined) {
      sets.push('output_json = ?');
      values.push(params.output === null ? null : JSON.stringify(params.output));
    }
    if (params.error !== undefined) {
      sets.push('error_json = ?');
      values.push(params.error === null ? null : JSON.stringify(params.error));
    }
    if (params.approvalId !== undefined) {
      sets.push('approval_id = ?');
      values.push(params.approvalId);
    }
    if (params.approvalRequired !== undefined) {
      sets.push('approval_required = ?');
      values.push(params.approvalRequired ? 1 : 0);
    }
    if (params.retryCount !== undefined) {
      sets.push('retry_count = ?');
      values.push(params.retryCount);
    }
    if (params.dependencies !== undefined) {
      sets.push('dependencies_json = ?');
      values.push(JSON.stringify(params.dependencies));
    }
    if (params.childTaskIds !== undefined) {
      sets.push('child_task_ids_json = ?');
      values.push(JSON.stringify(params.childTaskIds));
    }
    if (params.cancellationRequested !== undefined) {
      sets.push('cancellation_requested = ?');
      values.push(params.cancellationRequested ? 1 : 0);
    }
    if (params.startedAt !== undefined) {
      sets.push('started_at = ?');
      values.push(params.startedAt);
    }
    if (params.finishedAt !== undefined) {
      sets.push('finished_at = ?');
      values.push(params.finishedAt);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(`UPDATE delegation_tasks SET ${sets.join(', ')} WHERE task_id = ?`)
        .run(...values, params.taskId);
      this.insertEvent(params.event);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getTask(params.taskId);
  }

  countActiveTasks(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM delegation_tasks
         WHERE status IN ('ASSIGNED', 'RUNNING', 'RETRYING')`,
      )
      .get() as unknown as { count: number };
    return Number(row.count);
  }

  countTasksByStatus(): Record<DelegationTaskStatus, number> {
    const counts = Object.fromEntries(
      DELEGATION_TASK_STATUSES.map((status) => [status, 0]),
    ) as Record<DelegationTaskStatus, number>;
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM delegation_tasks GROUP BY status')
      .all() as unknown as Array<{ status: DelegationTaskStatus; count: number }>;
    for (const row of rows) {
      counts[row.status] = Number(row.count);
    }
    return counts;
  }

  countProjectTasks(projectId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM delegation_tasks WHERE project_id = ?')
      .get(projectId) as unknown as { count: number };
    return Number(row.count);
  }

  listStaleTasks(nowIso: string, olderThanMs: number): DelegationTaskRecord[] {
    const cutoff = new Date(new Date(nowIso).getTime() - olderThanMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM delegation_tasks
         WHERE status IN ('ASSIGNED', 'RUNNING') AND updated_at < ?`,
      )
      .all(cutoff) as unknown as RawTaskRow[];
    return rows.map(rowToTask);
  }

  recoverInterruptedTasks(nowIso: string): { requeued: string[]; failed: string[] } {
    const interrupted = this.db
      .prepare(
        `SELECT * FROM delegation_tasks
         WHERE status IN ('ASSIGNED', 'RUNNING', 'VALIDATING', 'RETRYING')`,
      )
      .all() as unknown as RawTaskRow[];
    const requeued: string[] = [];
    const failed: string[] = [];
    const clearAgent = this.db.prepare(
      `UPDATE department_agent_state
       SET current_task_id = NULL, health = 'unknown', updated_at = ?
       WHERE current_task_id = ?`,
    );
    for (const row of interrupted) {
      clearAgent.run(nowIso, row.task_id);
      if (row.cancellation_requested === 1) {
        this.updateTask({
          taskId: row.task_id,
          status: 'CANCELLED',
          finishedAt: nowIso,
          updatedAt: nowIso,
          event: {
            event_id: `evt_${row.task_id}_recovered_cancelled`,
            task_id: row.task_id,
            event_type: 'task.recovery.cancelled',
            from_status: row.status,
            to_status: 'CANCELLED',
            actor_id: 'system:delegation_engine',
            message: 'Interrupted task was already marked for cancellation.',
            metadata: {},
            created_at: nowIso,
          },
        });
        continue;
      }
      const wasExecuting = ['ASSIGNED', 'RUNNING', 'RETRYING'].includes(row.status);
      if (wasExecuting && row.retry_count >= row.max_retries) {
        this.updateTask({
          taskId: row.task_id,
          status: 'FAILED',
          error: {
            code: 'RECOVERY_LIMIT_EXCEEDED',
            message: 'Task was interrupted too many times across restarts and was not retried again.',
            retryable: false,
          },
          finishedAt: nowIso,
          updatedAt: nowIso,
          event: {
            event_id: `evt_${row.task_id}_recovery_failed_${Date.now()}`,
            task_id: row.task_id,
            event_type: 'task.recovery.failed',
            from_status: row.status,
            to_status: 'FAILED',
            actor_id: 'system:delegation_engine',
            message: 'Interrupted task exceeded its recovery/retry limit.',
            metadata: { previous_status: row.status, retry_count: row.retry_count },
            created_at: nowIso,
          },
        });
        failed.push(row.task_id);
        continue;
      }
      this.updateTask({
        taskId: row.task_id,
        status: 'QUEUED',
        retryCount: wasExecuting ? row.retry_count + 1 : row.retry_count,
        startedAt: null,
        updatedAt: nowIso,
        event: {
          event_id: `evt_${row.task_id}_recovered_${Date.now()}`,
          task_id: row.task_id,
          event_type: 'task.recovery.requeued',
          from_status: row.status,
          to_status: 'QUEUED',
          actor_id: 'system:delegation_engine',
          message: 'Interrupted task requeued after application restart.',
          metadata: { previous_status: row.status },
          created_at: nowIso,
        },
      });
      requeued.push(row.task_id);
    }
    return { requeued, failed };
  }

  appendEvent(event: DelegationTaskEventRecord): void {
    this.insertEvent(event);
  }

  private insertEvent(event: DelegationTaskEventRecord): void {
    this.db
      .prepare(
        `INSERT INTO delegation_task_events
          (event_id, task_id, event_type, from_status, to_status, actor_id, message, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  listEvents(taskId: string, limit = 200): DelegationTaskEventRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM delegation_task_events
           WHERE task_id = ? ORDER BY created_at ASC LIMIT ?`,
        )
        .all(taskId, Math.max(1, Math.min(500, limit))) as unknown as RawEventRow[]
    ).map(rowToEvent);
  }

  listRecentEvents(limit = 100): DelegationTaskEventRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM delegation_task_events
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(Math.max(1, Math.min(500, limit))) as unknown as RawEventRow[]
    ).map(rowToEvent);
  }

  upsertWorkerHeartbeat(record: WorkerHeartbeatRecord): WorkerHeartbeatRecord {
    this.db
      .prepare(
        `INSERT INTO model_worker_heartbeats
          (worker_id, runtime_type, endpoint, health, active_jobs, queue_length,
           latency_ms, models_json, last_error, last_heartbeat_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET
           runtime_type = excluded.runtime_type,
           endpoint = excluded.endpoint,
           health = excluded.health,
           active_jobs = excluded.active_jobs,
           queue_length = excluded.queue_length,
           latency_ms = excluded.latency_ms,
           models_json = excluded.models_json,
           last_error = excluded.last_error,
           last_heartbeat_at = excluded.last_heartbeat_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.worker_id,
        record.runtime_type,
        record.endpoint,
        record.health,
        record.active_jobs,
        record.queue_length,
        record.latency_ms,
        JSON.stringify(record.models),
        record.last_error,
        record.last_heartbeat_at,
        record.updated_at,
      );
    return record;
  }

  listWorkerHeartbeats(): WorkerHeartbeatRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM model_worker_heartbeats ORDER BY worker_id ASC')
        .all() as unknown as RawHeartbeatRow[]
    ).map((row) => ({
      worker_id: row.worker_id,
      runtime_type: row.runtime_type,
      endpoint: row.endpoint,
      health: row.health,
      active_jobs: row.active_jobs,
      queue_length: row.queue_length,
      latency_ms: row.latency_ms,
      models: parseJson(row.models_json, []),
      last_error: row.last_error,
      last_heartbeat_at: row.last_heartbeat_at,
      updated_at: row.updated_at,
    }));
  }

  createAlert(alert: ExecutionAlertRecord): ExecutionAlertRecord {
    this.db
      .prepare(
        `INSERT INTO execution_alerts
          (alert_id, severity, code, message, task_id, agent_id, worker_id, created_at, acknowledged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        alert.alert_id,
        alert.severity,
        alert.code,
        alert.message,
        alert.task_id,
        alert.agent_id,
        alert.worker_id,
        alert.created_at,
        alert.acknowledged_at,
      );
    return alert;
  }

  listAlerts(limit = 100): ExecutionAlertRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM execution_alerts ORDER BY created_at DESC LIMIT ?')
        .all(Math.max(1, Math.min(500, limit))) as unknown as RawAlertRow[]
    ).map((row) => ({ ...row }));
  }

  acknowledgeAlert(alertId: string, acknowledgedAt: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE execution_alerts SET acknowledged_at = ? WHERE alert_id = ? AND acknowledged_at IS NULL',
      )
      .run(acknowledgedAt, alertId);
    return Number(result.changes) === 1;
  }
}
