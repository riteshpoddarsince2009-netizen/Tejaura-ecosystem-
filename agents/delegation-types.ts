import type { ExecutionEnvironment } from '../contracts/types/index.ts';
import type { PolicyActor } from '../core/policy/index.ts';
import type { AgentRiskLevel, Stage46Department } from './agent-types.ts';

export const DELEGATION_TASK_STATUSES = [
  'CREATED',
  'VALIDATING',
  'QUEUED',
  'ASSIGNED',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type DelegationTaskStatus = (typeof DELEGATION_TASK_STATUSES)[number];

export type DelegationTerminalStatus = 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface DelegationProjectRecord {
  project_id: string;
  name: string;
  objective: string;
  context: Record<string, unknown>;
  allowed_agent_ids: string[];
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface DelegationTaskRecord {
  task_id: string;
  project_id: string;
  parent_task_id: string | null;
  root_task_id: string;
  agent_id: string;
  department: Stage46Department;
  status: DelegationTaskStatus;
  action: string;
  resource_id: string;
  environment: ExecutionEnvironment;
  title: string;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: { code: string; message: string; retryable: boolean } | null;
  risk_level: AgentRiskLevel;
  approval_id: string | null;
  approval_required: boolean;
  depth: number;
  max_depth: number;
  retry_count: number;
  max_retries: number;
  timeout_ms: number;
  idempotency_key: string | null;
  dependencies: string[];
  child_task_ids: string[];
  correlation_id: string;
  cancellation_requested: boolean;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DelegationTaskEventRecord {
  event_id: string;
  task_id: string;
  event_type: string;
  from_status: DelegationTaskStatus | null;
  to_status: DelegationTaskStatus | null;
  actor_id: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DepartmentAgentStateRecord {
  agent_id: string;
  status: 'active' | 'paused' | 'disabled' | 'retired';
  health: 'healthy' | 'degraded' | 'offline' | 'unknown';
  current_task_id: string | null;
  tasks_completed: number;
  tasks_failed: number;
  last_heartbeat_at: string | null;
  updated_at: string;
}

export interface WorkerHeartbeatRecord {
  worker_id: string;
  runtime_type: string;
  endpoint: string;
  health: 'healthy' | 'degraded' | 'offline' | 'unknown';
  active_jobs: number;
  queue_length: number;
  latency_ms: number | null;
  models: string[];
  last_error: string | null;
  last_heartbeat_at: string;
  updated_at: string;
}

export interface ExecutionAlertRecord {
  alert_id: string;
  severity: 'info' | 'warning' | 'critical';
  code: string;
  message: string;
  task_id: string | null;
  agent_id: string | null;
  worker_id: string | null;
  created_at: string;
  acknowledged_at: string | null;
}

export interface DelegationRequest {
  key: string;
  target_agent_id: string;
  title: string;
  description: string;
  action: string;
  input: Record<string, unknown>;
  depends_on_keys?: string[];
}

export interface AgentApprovalRequest {
  action: string;
  resource_id: string;
  reason: string;
  risk_level: AgentRiskLevel;
  required_scope: string;
  environment?: ExecutionEnvironment;
}

export interface DepartmentAgentResult {
  status: 'completed' | 'needs_approval' | 'blocked' | 'failed';
  summary: string;
  deliverables: Array<{
    name: string;
    kind:
      | 'plan'
      | 'specification'
      | 'copy'
      | 'code'
      | 'report'
      | 'review'
      | 'recommendation'
      | 'test_evidence';
    content: string;
  }>;
  delegations?: DelegationRequest[];
  approval_request?: AgentApprovalRequest;
  model_assisted: boolean;
  test_evidence?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ReviewAgentResult {
  status: 'completed' | 'needs_approval' | 'blocked' | 'failed';
  summary: string;
  verdict: 'pass' | 'pass_with_findings' | 'fail';
  findings: Array<{
    severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
    code: string;
    message: string;
    recommendation?: string;
  }>;
  acceptance_criteria?: Array<{
    criterion: string;
    met: boolean;
    evidence?: string;
  }>;
  model_assisted: boolean;
  metadata?: Record<string, unknown>;
}

export interface WatchdogResult {
  status: 'completed' | 'needs_approval' | 'blocked' | 'failed';
  summary: string;
  alerts: Array<{
    severity: 'info' | 'warning' | 'critical';
    code: string;
    message: string;
    task_id?: string;
    agent_id?: string;
    worker_id?: string;
  }>;
  model_assisted: boolean;
  metadata?: Record<string, unknown>;
}

export interface CreateObjectiveInput {
  name: string;
  objective: string;
  context?: Record<string, unknown>;
  environment?: ExecutionEnvironment;
  idempotency_key?: string;
}

export interface CreateObjectiveResult {
  project: DelegationProjectRecord;
  task: DelegationTaskRecord;
  duplicate: boolean;
}

export interface DelegationExecutionSummary {
  processed: number;
  completed: number;
  failed: number;
  waiting_for_approval: number;
  tasks: DelegationTaskRecord[];
}

export interface DelegationQueueMetrics {
  counts: Record<DelegationTaskStatus, number>;
  active: number;
  queued: number;
  waiting_for_approval: number;
  oldest_queued_age_ms: number | null;
  total: number;
}

export interface DelegationEngineOptions {
  store: DelegationStore;
  approvals: {
    requestApproval: (
      input: import('../core/approvals/index.ts').CreateApprovalRequestInput,
    ) => import('../core/approvals/index.ts').ApprovalOperationResult;
    verifyAndConsumeApproval: (
      input: import('../core/approvals/index.ts').VerifyAndConsumeApprovalInput,
    ) => import('../core/approvals/index.ts').ApprovalOperationResult;
    decideApproval: (
      input: import('../core/approvals/index.ts').DecideApprovalInput,
    ) => import('../core/approvals/index.ts').ApprovalOperationResult;
    getApproval: (
      approvalId: string,
    ) => import('../core/approvals/index.ts').ApprovalRecord | null;
  };
  auditLogger: import('../core/audit/index.ts').AuditLogger;
  systemConfig: unknown;
  clock?: () => Date;
  modelWorker?: import('./model-worker/model-worker-types.ts').ModelWorkerClient | null;
  sandboxExecutor?: DelegationSandboxExecutor | null;
  maxConcurrentTasks?: number;
  maxDelegationDepth?: number;
  maxTotalTasksPerProject?: number;
  stuckTaskAfterMs?: number;
}

export interface DelegationSandboxExecutor {
  runEngineeringTask(params: {
    task: DelegationTaskRecord;
    agentId: string;
    input: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<{
    ok: boolean;
    result?: Record<string, unknown>;
    error?: { code: string; message: string; retryable: boolean };
  }>;
  getCapabilities?(): Promise<Record<string, unknown>>;
}

export interface DelegationStore {
  close(): void;
  seedDepartmentAgentState(agentIds: readonly string[], nowIso: string): void;
  getDepartmentAgentState(agentId: string): DepartmentAgentStateRecord | null;
  listDepartmentAgentStates(): DepartmentAgentStateRecord[];
  updateDepartmentAgentState(params: {
    agentId: string;
    status?: DepartmentAgentStateRecord['status'];
    health?: DepartmentAgentStateRecord['health'];
    currentTaskId?: string | null;
    incrementCompleted?: boolean;
    incrementFailed?: boolean;
    lastHeartbeatAt?: string | null;
    updatedAt: string;
  }): DepartmentAgentStateRecord | null;

  createProject(project: DelegationProjectRecord): DelegationProjectRecord;
  getProject(projectId: string): DelegationProjectRecord | null;
  listProjects(limit?: number): DelegationProjectRecord[];

  createTask(params: {
    task: DelegationTaskRecord;
    event: DelegationTaskEventRecord;
  }): { created: boolean; task: DelegationTaskRecord };
  getTask(taskId: string): DelegationTaskRecord | null;
  getTaskByIdempotencyKey(key: string): DelegationTaskRecord | null;
  listTasks(filter?: {
    projectId?: string;
    parentTaskId?: string | null;
    status?: DelegationTaskStatus;
    agentId?: string;
    limit?: number;
  }): DelegationTaskRecord[];
  listChildren(parentTaskId: string): DelegationTaskRecord[];
  claimNextQueuedTask(nowIso: string): DelegationTaskRecord | null;
  claimTask(taskId: string, nowIso: string): DelegationTaskRecord | null;
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
  }): DelegationTaskRecord | null;
  countActiveTasks(): number;
  countTasksByStatus(): Record<DelegationTaskStatus, number>;
  countProjectTasks(projectId: string): number;
  listStaleTasks(nowIso: string, olderThanMs: number): DelegationTaskRecord[];
  recoverInterruptedTasks(nowIso: string): { requeued: string[]; failed: string[] };

  appendEvent(event: DelegationTaskEventRecord): void;
  listEvents(taskId: string, limit?: number): DelegationTaskEventRecord[];
  listRecentEvents(limit?: number): DelegationTaskEventRecord[];

  upsertWorkerHeartbeat(record: WorkerHeartbeatRecord): WorkerHeartbeatRecord;
  listWorkerHeartbeats(): WorkerHeartbeatRecord[];

  createAlert(alert: ExecutionAlertRecord): ExecutionAlertRecord;
  listAlerts(limit?: number): ExecutionAlertRecord[];
  acknowledgeAlert(alertId: string, acknowledgedAt: string): boolean;
}

export interface DelegationActorContext {
  actor: PolicyActor;
  correlation_id: string;
}
