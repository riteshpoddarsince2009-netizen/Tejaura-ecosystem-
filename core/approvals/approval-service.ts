import crypto from 'node:crypto';

import type { Approval } from '../../contracts/types/index.ts';
import { validateApproval } from '../../contracts/validation/index.ts';
import type { AuditLogger } from '../audit/index.ts';
import type {
  ApprovalOperationResult,
  ApprovalRecord,
  ApprovalServiceOptions,
  ApprovalStore,
  CreateApprovalRequestInput,
  DecideApprovalInput,
  VerifyAndConsumeApprovalInput,
} from './approval-types.ts';

function cloneRecord(record: ApprovalRecord): ApprovalRecord {
  return {
    ...record,
    scope: {
      ...record.scope,
      resources: [...record.scope.resources],
      permissions: [...record.scope.permissions],
    },
  };
}

export function toContractApproval(record: ApprovalRecord): Approval {
  const { consumed_at: _consumedAt, consumed_for_task_id: _consumedTask, ...approval } =
    record;
  return approval;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();

  get(approvalId: string): ApprovalRecord | null {
    const existing = this.records.get(approvalId);
    return existing ? cloneRecord(existing) : null;
  }

  save(record: ApprovalRecord): void {
    this.records.set(record.id, cloneRecord(record));
  }

  listAll(): ApprovalRecord[] {
    return [...this.records.values()].map(cloneRecord);
  }
}

export class ApprovalService {
  private readonly designatedOwnerId: string;
  private readonly store: ApprovalStore;
  private readonly auditLogger?: AuditLogger;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: ApprovalServiceOptions) {
    if (
      typeof options.designatedOwnerId !== 'string' ||
      options.designatedOwnerId.trim().length < 2 ||
      /^agent([_.:-]|$)/i.test(options.designatedOwnerId)
    ) {
      throw new Error(
        'designatedOwnerId must be a valid non-agent human owner identifier.',
      );
    }

    this.designatedOwnerId = options.designatedOwnerId;
    this.store = options.store ?? new InMemoryApprovalStore();
    this.auditLogger = options.auditLogger;
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator =
      options.idGenerator ?? (() => `apr_${crypto.randomUUID()}`);
  }

  getApproval(approvalId: string): ApprovalRecord | null {
    return this.store.get(approvalId);
  }

  listApprovals(): ApprovalRecord[] {
    return this.store.listAll();
  }

  requestApproval(input: CreateApprovalRequestInput): ApprovalOperationResult {
    if (
      !input ||
      typeof input.task_id !== 'string' ||
      typeof input.action !== 'string' ||
      typeof input.requested_by !== 'string' ||
      typeof input.reason !== 'string' ||
      !input.scope
    ) {
      return {
        ok: false,
        code: 'MALFORMED_APPROVAL_REQUEST',
        error: 'Approval request is missing required fields.',
      };
    }

    if (
      input.scope.resources.some((r) => r.includes('*')) ||
      input.scope.permissions.some((p) => p.includes('*'))
    ) {
      return {
        ok: false,
        code: 'WILDCARD_SCOPE_FORBIDDEN',
        error: 'Approval scope resources and permissions must not use wildcards.',
      };
    }

    const now = this.clock();
    const nowIso = now.toISOString();

    if (
      input.scope.expires_at !== undefined &&
      input.scope.expires_at !== null
    ) {
      const expiresMs = new Date(input.scope.expires_at).getTime();
      if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) {
        return {
          ok: false,
          code: 'INVALID_EXPIRATION',
          error: 'Approval expires_at must be a valid future timestamp.',
        };
      }
    }

    const record: ApprovalRecord = {
      id: this.idGenerator(),
      task_id: input.task_id,
      action: input.action,
      requested_by: input.requested_by,
      requested_at: nowIso,
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      reason: input.reason,
      scope: {
        resources: [...input.scope.resources],
        permissions: [...input.scope.permissions],
        single_use: input.scope.single_use,
        expires_at: input.scope.expires_at ?? null,
      },
      environment: input.environment,
      schema_version: '1.0.0',
      consumed_at: null,
      consumed_for_task_id: null,
    };

    const contractCheck = validateApproval(toContractApproval(record));
    if (!contractCheck.valid) {
      return {
        ok: false,
        code: 'CONTRACT_VALIDATION_FAILED',
        error: contractCheck.errors.map((e) => e.message).join('; '),
      };
    }

    if (this.auditLogger) {
      const auditRes = this.auditLogger.logApprovalRequest({
        actor_id: record.requested_by,
        approval_id: record.id,
        task_id: record.task_id,
        action: record.action,
        outcome: 'pending',
        correlation_id: input.correlation_id,
        metadata: {
          environment: record.environment,
          resources: record.scope.resources,
          permissions: record.scope.permissions,
          single_use: record.scope.single_use,
        },
      });

      if (!auditRes.ok) {
        return {
          ok: false,
          code: 'AUDIT_STORAGE_FAILURE',
          error: `Approval request aborted because audit logging failed: ${auditRes.error}`,
        };
      }
    }

    this.store.save(record);
    return { ok: true, record: cloneRecord(record) };
  }

  decideApproval(input: DecideApprovalInput): ApprovalOperationResult {
    const existing = this.store.get(input.approval_id);
    if (!existing) {
      return {
        ok: false,
        code: 'APPROVAL_NOT_FOUND',
        error: `Approval "${input.approval_id}" was not found.`,
      };
    }

    if (input.decision !== 'approved' && input.decision !== 'rejected') {
      return {
        ok: false,
        code: 'INVALID_STATE_TRANSITION',
        error: `Decision must be "approved" or "rejected", got "${String(input.decision)}".`,
      };
    }

    // Strict state machine: only `pending` can transition to `approved` or `rejected`.
    if (existing.status !== 'pending') {
      this.auditFailure(
        input.reviewer?.actor_id || 'unknown_reviewer',
        existing.id,
        existing.action,
        'INVALID_STATE_TRANSITION',
        input.correlation_id,
      );
      return {
        ok: false,
        code: 'INVALID_STATE_TRANSITION',
        error: `Cannot transition approval from terminal state "${existing.status}" to "${input.decision}".`,
      };
    }

    // Reviewer trust boundary checks: authenticated designated human owner only.
    if (
      !input.reviewer ||
      input.reviewer.authenticated !== true ||
      typeof input.reviewer.auth_source !== 'string' ||
      input.reviewer.auth_source.trim().length === 0
    ) {
      this.auditFailure(
        input.reviewer?.actor_id || 'unauthenticated_actor',
        existing.id,
        existing.action,
        'UNAUTHENTICATED_REVIEWER',
        input.correlation_id,
      );
      return {
        ok: false,
        code: 'UNAUTHENTICATED_REVIEWER',
        error:
          'Approval decisions require an externally authenticated owner identity.',
      };
    }

    if (
      input.reviewer.actor_type !== 'owner' ||
      /^agent([_.:-]|$)/i.test(input.reviewer.actor_id)
    ) {
      this.auditFailure(
        input.reviewer.actor_id,
        existing.id,
        existing.action,
        'AGENT_APPROVAL_FORBIDDEN',
        input.correlation_id,
      );
      return {
        ok: false,
        code: 'AGENT_APPROVAL_FORBIDDEN',
        error: 'Agents and non-owner actors cannot approve or reject requests.',
      };
    }

    if (input.reviewer.actor_id === existing.requested_by) {
      this.auditFailure(
        input.reviewer.actor_id,
        existing.id,
        existing.action,
        'SELF_APPROVAL_FORBIDDEN',
        input.correlation_id,
      );
      return {
        ok: false,
        code: 'SELF_APPROVAL_FORBIDDEN',
        error: 'Requester cannot approve or reject their own approval request.',
      };
    }

    if (input.reviewer.actor_id !== this.designatedOwnerId) {
      this.auditFailure(
        input.reviewer.actor_id,
        existing.id,
        existing.action,
        'NON_DESIGNATED_OWNER_FORBIDDEN',
        input.correlation_id,
      );
      return {
        ok: false,
        code: 'NON_DESIGNATED_OWNER_FORBIDDEN',
        error: `Only the designated human owner "${this.designatedOwnerId}" may decide approvals.`,
      };
    }

    const now = this.clock();
    const nowMs = now.getTime();

    // Enforce expiration before transitioning to approved/rejected.
    if (
      existing.scope.expires_at !== undefined &&
      existing.scope.expires_at !== null
    ) {
      const expiresMs = new Date(existing.scope.expires_at).getTime();
      if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
        const expiredRecord: ApprovalRecord = {
          ...existing,
          status: 'expired',
        };
        this.store.save(expiredRecord);
        this.auditFailure(
          input.reviewer.actor_id,
          existing.id,
          existing.action,
          'APPROVAL_EXPIRED',
          input.correlation_id,
        );
        return {
          ok: false,
          code: 'APPROVAL_EXPIRED',
          error: 'Approval request has expired and transitioned to expired.',
        };
      }
    }

    const updated: ApprovalRecord = {
      ...existing,
      status: input.decision,
      reviewed_by: input.reviewer.actor_id,
      reviewed_at: now.toISOString(),
      reason: input.reason,
    };

    const contractCheck = validateApproval(toContractApproval(updated));
    if (!contractCheck.valid) {
      return {
        ok: false,
        code: 'CONTRACT_VALIDATION_FAILED',
        error: contractCheck.errors.map((e) => e.message).join('; '),
      };
    }

    if (this.auditLogger) {
      const auditRes = this.auditLogger.logApprovalDecision({
        actor_type: 'owner',
        actor_id: input.reviewer.actor_id,
        approval_id: updated.id,
        action: updated.action,
        outcome: updated.status === 'approved' ? 'success' : 'denied',
        correlation_id: input.correlation_id,
        metadata: {
          decision: updated.status,
          auth_source: input.reviewer.auth_source,
          environment: updated.environment,
        },
      });

      if (!auditRes.ok) {
        return {
          ok: false,
          code: 'AUDIT_STORAGE_FAILURE',
          error: `Approval decision aborted because audit logging failed: ${auditRes.error}`,
        };
      }
    }

    this.store.save(updated);
    return { ok: true, record: cloneRecord(updated) };
  }

  expireApproval(
    approvalId: string,
    correlationId: string,
  ): ApprovalOperationResult {
    const existing = this.store.get(approvalId);
    if (!existing) {
      return {
        ok: false,
        code: 'APPROVAL_NOT_FOUND',
        error: `Approval "${approvalId}" was not found.`,
      };
    }

    if (existing.status !== 'pending') {
      return {
        ok: false,
        code: 'INVALID_STATE_TRANSITION',
        error: `Cannot expire approval from state "${existing.status}".`,
      };
    }

    const expired: ApprovalRecord = {
      ...existing,
      status: 'expired',
    };

    if (this.auditLogger) {
      const auditRes = this.auditLogger.logApprovalDecision({
        actor_type: 'system',
        actor_id: 'approval_gatekeeper',
        approval_id: expired.id,
        action: expired.action,
        outcome: 'cancelled',
        correlation_id: correlationId,
        metadata: { decision: 'expired' },
      });
      if (!auditRes.ok) {
        return {
          ok: false,
          code: 'AUDIT_STORAGE_FAILURE',
          error: `Approval expiration aborted because audit logging failed: ${auditRes.error}`,
        };
      }
    }

    this.store.save(expired);
    return { ok: true, record: cloneRecord(expired) };
  }

  verifyAndConsumeApproval(
    input: VerifyAndConsumeApprovalInput,
  ): ApprovalOperationResult {
    const existing = this.store.get(input.approval_id);
    if (!existing) {
      return {
        ok: false,
        code: 'APPROVAL_NOT_FOUND',
        error: `Approval "${input.approval_id}" was not found.`,
      };
    }

    if (existing.status !== 'approved') {
      this.auditFailure(
        input.actor_id,
        existing.id,
        input.action,
        `APPROVAL_STATUS_${existing.status.toUpperCase()}`,
        input.correlation_id,
      );
      return {
        ok: false,
        code: `APPROVAL_NOT_APPROVED`,
        error: `Approval status is "${existing.status}", not "approved".`,
      };
    }

    if (
      existing.reviewed_by === null ||
      existing.reviewed_by === existing.requested_by ||
      existing.reviewed_by === input.actor_id ||
      existing.reviewed_by !== this.designatedOwnerId
    ) {
      this.auditFailure(
        input.actor_id,
        existing.id,
        input.action,
        'INVALID_APPROVAL_REVIEWER',
        input.correlation_id,
      );
      return {
        ok: false,
        code: 'INVALID_APPROVAL_REVIEWER',
        error: 'Approval was not granted by a valid non-self designated owner.',
      };
    }

    if (existing.task_id !== input.task_id) {
      return {
        ok: false,
        code: 'APPROVAL_TASK_MISMATCH',
        error: `Approval belongs to task "${existing.task_id}", not "${input.task_id}".`,
      };
    }

    if (existing.action !== input.action) {
      return {
        ok: false,
        code: 'APPROVAL_ACTION_MISMATCH',
        error: `Approval action "${existing.action}" does not match "${input.action}".`,
      };
    }

    if (existing.environment !== input.environment) {
      return {
        ok: false,
        code: 'APPROVAL_ENVIRONMENT_MISMATCH',
        error: `Approval environment "${existing.environment}" does not match "${input.environment}".`,
      };
    }

    if (!existing.scope.resources.includes(input.resource_id)) {
      return {
        ok: false,
        code: 'APPROVAL_RESOURCE_MISMATCH',
        error: `Approval does not include resource "${input.resource_id}".`,
      };
    }

    if (!existing.scope.permissions.includes(input.required_scope)) {
      return {
        ok: false,
        code: 'APPROVAL_SCOPE_MISMATCH',
        error: `Approval does not include scope "${input.required_scope}".`,
      };
    }

    const now = this.clock();
    const nowMs = now.getTime();
    if (
      existing.scope.expires_at !== undefined &&
      existing.scope.expires_at !== null
    ) {
      const expiresMs = new Date(existing.scope.expires_at).getTime();
      if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
        return {
          ok: false,
          code: 'APPROVAL_EXPIRED',
          error: 'Approval expiration timestamp has passed.',
        };
      }
    }

    if (existing.scope.single_use && existing.consumed_at !== null) {
      this.auditFailure(
        input.actor_id,
        existing.id,
        input.action,
        'SINGLE_USE_ALREADY_CONSUMED',
        input.correlation_id,
      );
      return {
        ok: false,
        code: 'SINGLE_USE_ALREADY_CONSUMED',
        error: 'Single-use approval has already been consumed.',
      };
    }

    const updated: ApprovalRecord = existing.scope.single_use
      ? {
          ...existing,
          consumed_at: now.toISOString(),
          consumed_for_task_id: input.task_id,
        }
      : existing;

    if (this.auditLogger) {
      const auditRes = this.auditLogger.logEvent({
        actor_type: 'policy_engine',
        actor_id: 'approval_gatekeeper',
        event_type: 'approval.consumed',
        resource_type: 'approval',
        resource_id: updated.id,
        action: input.action,
        outcome: 'success',
        correlation_id: input.correlation_id,
        approval_id: updated.id,
        metadata: {
          task_id: input.task_id,
          environment: input.environment,
          single_use: updated.scope.single_use,
        },
      });
      if (!auditRes.ok) {
        return {
          ok: false,
          code: 'AUDIT_STORAGE_FAILURE',
          error: `Approval consumption blocked because audit logging failed: ${auditRes.error}`,
        };
      }
    }

    if (updated !== existing) {
      this.store.save(updated);
    }

    return { ok: true, record: cloneRecord(updated) };
  }

  private auditFailure(
    actorId: string,
    approvalId: string,
    action: string,
    errorCode: string,
    correlationId: string,
  ): void {
    if (!this.auditLogger) {
      return;
    }
    this.auditLogger.logFailure({
      actor_type: 'policy_engine',
      actor_id: actorId || 'unknown_actor',
      resource_type: 'approval',
      resource_id: approvalId,
      action,
      error_code: errorCode,
      correlation_id: correlationId,
      approval_id: approvalId,
    });
  }
}
