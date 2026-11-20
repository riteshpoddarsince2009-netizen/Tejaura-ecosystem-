export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type ExecutionEnvironment =
  | 'sandbox'
  | 'local'
  | 'staging'
  | 'production';

export interface ApprovalScope {
  resources: string[];
  permissions: string[];
  single_use: boolean;
  expires_at?: string | null;
}

export interface Approval {
  id: string;
  task_id: string;
  action: string;
  requested_by: string;
  requested_at: string;
  status: ApprovalStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reason: string;
  scope: ApprovalScope;
  environment?: ExecutionEnvironment;
  schema_version?: string;
}
