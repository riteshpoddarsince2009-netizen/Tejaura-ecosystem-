import type {
  AutonomyLevel,
  ExecutionEnvironment,
  TaskError,
  TaskStatus,
} from '../../contracts/types/index.ts';
import type { TrustedReviewerContext } from '../../core/approvals/index.ts';
import type { PolicyActor } from '../../core/policy/index.ts';
import type {
  ExecutionAttemptRecord,
  OrchestratedTaskRecord,
  ScheduleRecord,
  ScheduleTaskTemplate,
  TaskEventRecord,
} from '../db/index.ts';

export interface SubmitTaskInput {
  type: string;
  title: string;
  description: string;
  action: string;
  resource_id: string;
  environment: ExecutionEnvironment;
  autonomy_level: AutonomyLevel;
  declared_scopes: string[];
  priority?: number;
  idempotency_key?: string;
  idempotent_action?: boolean;
  deadline_at?: string | null;
  max_retries?: number;
  timeout_ms?: number;
  input: Record<string, unknown>;
  assigned_agent_id?: string | null;
  owner_confirmed_l4?: boolean;
  schedule_id?: string | null;
}

export interface TaskSubmissionContext {
  actor: PolicyActor;
  correlation_id: string;
}

export type SubmitTaskResult =
  | {
      ok: true;
      duplicate: boolean;
      task: OrchestratedTaskRecord;
      approval_id?: string;
    }
  | {
      ok: false;
      code: string;
      error: string;
    };

export interface CreateScheduleInput {
  name: string;
  description: string;
  interval_seconds: number;
  first_run_at?: string;
  enabled?: boolean;
  task_template: ScheduleTaskTemplate;
}

export interface TaskExecutionHandlerContext {
  task: OrchestratedTaskRecord;
  attempt: ExecutionAttemptRecord;
  signal: AbortSignal;
  markExternalEffectDispatched: () => void;
}

export type TaskHandlerOutcome =
  | {
      ok: true;
      result: Record<string, unknown>;
      runtime_type?: string | null;
      model_id?: string | null;
    }
  | {
      ok: false;
      error: TaskError;
      runtime_type?: string | null;
      model_id?: string | null;
    };

export type ExternalTaskActionHandler = (
  ctx: TaskExecutionHandlerContext,
) => Promise<TaskHandlerOutcome>;

export interface TaskDetailSnapshot {
  task: OrchestratedTaskRecord;
  events: TaskEventRecord[];
  attempts: ExecutionAttemptRecord[];
}

export interface WorkerTickReport {
  recovered_abandoned: number;
  schedules_triggered: number;
  task_executed: boolean;
  executed_task_id?: string;
  executed_status?: TaskStatus;
}

export interface DecideApprovalForTaskInput {
  approval_id: string;
  decision: 'approved' | 'rejected';
  reviewer: TrustedReviewerContext;
  reason: string;
  correlation_id: string;
}
