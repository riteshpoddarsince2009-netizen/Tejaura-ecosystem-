export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface TaskError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface Task {
  id: string;
  type: string;
  title: string;
  description: string;
  status: TaskStatus;
  autonomy_level: AutonomyLevel;
  created_at: string;
  updated_at: string;
  requested_by: string;
  assigned_agent_id: string | null;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: TaskError | null;
  approval_ids: string[];
  schema_version?: string;
}
