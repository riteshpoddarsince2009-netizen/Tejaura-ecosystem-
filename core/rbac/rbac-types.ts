import type { AuditActorType } from '../../contracts/types/index.ts';
import type { TrustedReviewerContext } from '../approvals/index.ts';
import type { AuditLogger } from '../audit/index.ts';
import type { PolicyActor } from '../policy/index.ts';
import type { TejauraRole } from '../security/index.ts';

export type RbacPermission =
  | 'governance:read'
  | 'governance:write'
  | 'approval:decide'
  | 'auth:admin'
  | 'auth:session:manage_self'
  | 'rbac:manage'
  | 'secrets:read'
  | 'secrets:write'
  | 'secrets:rotate'
  | 'secrets:inventory'
  | 'worker:airllm:token'
  | 'model:discover:local'
  | 'model:invoke:local'
  | 'model:registry:write'
  | 'workspace:read'
  | 'proposal:draft'
  | 'sandbox:write'
  | 'sandbox:execute'
  | 'audit:read';

export interface RbacPrincipal {
  actor_id: string;
  actor_type: AuditActorType;
  role: TejauraRole | string;
  authenticated: boolean;
  auth_source: string;
  session_id?: string;
}

export interface RbacCheckInput {
  principal: RbacPrincipal;
  permission: RbacPermission | string;
  resource_id?: string;
  correlation_id?: string;
  auditLogger?: AuditLogger;
}

export type RbacDecision =
  | {
      allowed: true;
      role: TejauraRole;
      permission: RbacPermission;
      reason_code: 'RBAC_ALLOW';
    }
  | {
      allowed: false;
      reason_code: string;
      reason: string;
    };

export interface RbacBridgeContext {
  toPolicyActor: () => PolicyActor;
  toTrustedReviewerContext: () => TrustedReviewerContext;
}
