import type {
  Approval,
  ApprovalScope,
  ExecutionEnvironment,
} from '../../contracts/types/index.ts';
import type { AuditLogger } from '../audit/index.ts';

export interface ApprovalRecord extends Approval {
  environment: ExecutionEnvironment;
  consumed_at: string | null;
  consumed_for_task_id: string | null;
}

export interface ApprovalStore {
  get: (approvalId: string) => ApprovalRecord | null;
  save: (record: ApprovalRecord) => void;
  listAll: () => ApprovalRecord[];
}

/**
 * External authentication boundary: TEJAURA does not fabricate a login
 * system in Stage 1. Callers MUST supply an externally authenticated owner
 * context; an approval record is never proof of identity.
 */
export interface TrustedReviewerContext {
  actor_id: string;
  actor_type: 'owner' | 'agent' | 'system' | 'adapter';
  authenticated: boolean;
  auth_source: string;
}

export interface CreateApprovalRequestInput {
  task_id: string;
  action: string;
  requested_by: string;
  environment: ExecutionEnvironment;
  reason: string;
  scope: ApprovalScope;
  correlation_id: string;
}

export interface DecideApprovalInput {
  approval_id: string;
  decision: 'approved' | 'rejected';
  reviewer: TrustedReviewerContext;
  reason: string;
  correlation_id: string;
}

export interface VerifyAndConsumeApprovalInput {
  approval_id: string;
  task_id: string;
  action: string;
  resource_id: string;
  required_scope: string;
  environment: ExecutionEnvironment;
  actor_id: string;
  correlation_id: string;
}

export type ApprovalOperationResult =
  | {
      ok: true;
      record: ApprovalRecord;
    }
  | {
      ok: false;
      code: string;
      error: string;
    };

export interface ApprovalServiceOptions {
  designatedOwnerId: string;
  store?: ApprovalStore;
  auditLogger?: AuditLogger;
  clock?: () => Date;
  idGenerator?: () => string;
}
