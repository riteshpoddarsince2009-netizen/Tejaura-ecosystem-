import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Approval, Task, TaskError, TaskStatus } from '../../contracts/types/index.ts';
import { validateApproval, validateTask } from '../../contracts/validation/index.ts';
import { toContractApproval, type ApprovalRecord } from '../../core/approvals/index.ts';
import { applyStage3Migrations, type AppliedMigrationRecord } from './migrations.ts';
import type {
  CreateTaskPersistenceInput,
  ExecutionAttemptRecord,
  ExecutionAttemptStatus,
  LeaseRecoveryReport,
  LeasedTaskAttempt,
  OrchestratedTaskRecord,
  OrchestrationStore,
  ScheduleRecord,
  ScheduleTaskTemplate,
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

/**
 * Persistent SQLite-backed OrchestrationStore & ApprovalStore using Node 22
 * built-in `node:sqlite` (`DatabaseSync`) with WAL mode, migrations, contract
 * validation, worker leases, and crash/restart recovery.
 */
export class SqliteOrchestrationStore implements OrchestrationStore {
  private readonly db: DatabaseSync;
  private readonly migrations: AppliedMigrationRecord[];

  constructor(options: { dbPath: string }) {
    const safePath = assertSafeDbFilePath(options.dbPath);
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
}
