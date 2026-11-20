import type { TrustedReviewerContext } from '../approvals/index.ts';
import type { AuditLogger } from '../audit/index.ts';
import type { PolicyActor } from '../policy/index.ts';
import type { TejauraRole } from '../security/index.ts';
import type {
  RbacCheckInput,
  RbacDecision,
  RbacPermission,
  RbacPrincipal,
} from './rbac-types.ts';

export const ROLE_PERMISSIONS: Readonly<
  Record<TejauraRole, readonly RbacPermission[]>
> = {
  owner: [
    'governance:read',
    'governance:write',
    'approval:decide',
    'auth:admin',
    'auth:session:manage_self',
    'rbac:manage',
    'secrets:read',
    'secrets:write',
    'secrets:rotate',
    'secrets:inventory',
    'worker:airllm:token',
    'model:discover:local',
    'model:invoke:local',
    'model:registry:write',
    'workspace:read',
    'proposal:draft',
    'sandbox:write',
    'sandbox:execute',
    'audit:read',
  ],
  operator_readonly: [
    'governance:read',
    'model:discover:local',
    'secrets:inventory',
    'audit:read',
  ],
  agent_restricted: [
    'governance:read',
    'workspace:read',
    'proposal:draft',
    'sandbox:write',
    'sandbox:execute',
    'model:discover:local',
    'model:invoke:local',
  ],
  worker_service: [
    'worker:airllm:token',
    'model:discover:local',
  ],
};

function isKnownRole(role: string): role is TejauraRole {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role);
}

/**
 * Deterministic, fail-closed, default-deny RBAC authorization check.
 */
export function authorizeRbac(input: RbacCheckInput): RbacDecision {
  const principal = input?.principal;
  if (
    !principal ||
    typeof principal.actor_id !== 'string' ||
    principal.actor_id.trim().length < 2
  ) {
    return {
      allowed: false,
      reason_code: 'MISSING_PRINCIPAL_IDENTITY',
      reason: 'Authenticated principal identity is required.',
    };
  }

  if (principal.authenticated !== true) {
    auditDenied(input, 'UNAUTHENTICATED_PRINCIPAL');
    return {
      allowed: false,
      reason_code: 'UNAUTHENTICATED_PRINCIPAL',
      reason: 'Default-deny: unauthenticated principals are denied access.',
    };
  }

  if (!isKnownRole(principal.role)) {
    auditDenied(input, 'UNKNOWN_ROLE');
    return {
      allowed: false,
      reason_code: 'UNKNOWN_ROLE',
      reason: `Role "${String(principal.role)}" is not recognized.`,
    };
  }

  // Hard constitutional boundary: agents or agent-prefixed IDs may never hold owner role.
  if (
    principal.role === 'owner' &&
    (principal.actor_type !== 'owner' ||
      /^agent([_.:-]|$)/i.test(principal.actor_id))
  ) {
    auditDenied(input, 'AGENT_OWNER_ROLE_FORBIDDEN');
    return {
      allowed: false,
      reason_code: 'AGENT_OWNER_ROLE_FORBIDDEN',
      reason: 'Non-owner actors and agents may never hold the owner role.',
    };
  }

  // Agents are strictly blocked from secrets, auth admin, RBAC admin, and approvals.
  if (
    principal.actor_type === 'agent' &&
    (input.permission.startsWith('secrets:') ||
      input.permission.startsWith('auth:') ||
      input.permission === 'rbac:manage' ||
      input.permission === 'approval:decide' ||
      input.permission === 'worker:airllm:token')
  ) {
    auditDenied(input, 'AGENT_PRIVILEGED_PERMISSION_FORBIDDEN');
    return {
      allowed: false,
      reason_code: 'AGENT_PRIVILEGED_PERMISSION_FORBIDDEN',
      reason: `Agents are strictly forbidden from permission "${input.permission}".`,
    };
  }

  const allowedPerms = ROLE_PERMISSIONS[principal.role];
  if (!allowedPerms.includes(input.permission as RbacPermission)) {
    auditDenied(input, 'PERMISSION_NOT_GRANTED');
    return {
      allowed: false,
      reason_code: 'PERMISSION_NOT_GRANTED',
      reason: `Role "${principal.role}" does not grant "${input.permission}".`,
    };
  }

  return {
    allowed: true,
    role: principal.role,
    permission: input.permission as RbacPermission,
    reason_code: 'RBAC_ALLOW',
  };
}

function auditDenied(input: RbacCheckInput, reasonCode: string): void {
  if (!input.auditLogger || !input.correlation_id) {
    return;
  }
  input.auditLogger.logPermissionChange({
    actor_type: input.principal?.actor_type ?? 'system',
    actor_id: input.principal?.actor_id || 'unknown_actor',
    target_actor_id: input.resource_id ?? input.principal?.actor_id ?? 'unknown',
    event_type: 'rbac.access.denied',
    action: input.permission,
    outcome: 'denied',
    correlation_id: input.correlation_id,
    metadata: {
      reason_code: reasonCode,
      role: input.principal?.role ?? 'unknown',
    },
  });
}

export class RbacRoleRegistry {
  private readonly assignments = new Map<string, TejauraRole>();
  private readonly auditLogger?: AuditLogger;

  constructor(
    initialAssignments: Record<string, TejauraRole> = {},
    auditLogger?: AuditLogger,
  ) {
    for (const [actorId, role] of Object.entries(initialAssignments)) {
      if (isKnownRole(role)) {
        this.assignments.set(actorId, role);
      }
    }
    this.auditLogger = auditLogger;
  }

  getRole(actorId: string): TejauraRole | null {
    return this.assignments.get(actorId) ?? null;
  }

  exportSnapshot(): Record<string, TejauraRole> {
    const out: Record<string, TejauraRole> = {};
    for (const [k, v] of this.assignments.entries()) {
      out[k] = v;
    }
    return out;
  }

  assignRole(params: {
    actor: RbacPrincipal;
    target_actor_id: string;
    target_actor_type: RbacPrincipal['actor_type'];
    new_role: TejauraRole;
    correlation_id: string;
  }): { ok: true } | { ok: false; code: string; error: string } {
    const authz = authorizeRbac({
      principal: params.actor,
      permission: 'rbac:manage',
      resource_id: params.target_actor_id,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    if (!isKnownRole(params.new_role)) {
      return {
        ok: false,
        code: 'UNKNOWN_ROLE',
        error: `Cannot assign unknown role "${String(params.new_role)}".`,
      };
    }

    if (
      params.new_role === 'owner' &&
      (params.target_actor_type !== 'owner' ||
        /^agent([_.:-]|$)/i.test(params.target_actor_id))
    ) {
      return {
        ok: false,
        code: 'AGENT_OWNER_ROLE_FORBIDDEN',
        error: 'Agents or non-owner actors cannot be assigned the owner role.',
      };
    }

    const previousRole = this.assignments.get(params.target_actor_id) ?? null;
    this.assignments.set(params.target_actor_id, params.new_role);

    if (this.auditLogger) {
      const auditRes = this.auditLogger.logPermissionChange({
        actor_type: 'owner',
        actor_id: params.actor.actor_id,
        target_actor_id: params.target_actor_id,
        event_type: 'rbac.role.assigned',
        action: 'rbac:manage',
        outcome: 'success',
        correlation_id: params.correlation_id,
        metadata: {
          previous_role: previousRole,
          new_role: params.new_role,
        },
      });
      if (!auditRes.ok) {
        if (previousRole) {
          this.assignments.set(params.target_actor_id, previousRole);
        } else {
          this.assignments.delete(params.target_actor_id);
        }
        return {
          ok: false,
          code: 'AUDIT_STORAGE_FAILURE',
          error: `Role assignment rolled back due to audit failure: ${auditRes.error}`,
        };
      }
    }

    return { ok: true };
  }

  revokeRole(params: {
    actor: RbacPrincipal;
    target_actor_id: string;
    correlation_id: string;
  }): { ok: true } | { ok: false; code: string; error: string } {
    const authz = authorizeRbac({
      principal: params.actor,
      permission: 'rbac:manage',
      resource_id: params.target_actor_id,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    if (params.target_actor_id === params.actor.actor_id) {
      return {
        ok: false,
        code: 'CANNOT_REVOKE_OWN_OWNER_ROLE',
        error: 'Owner cannot revoke their own owner role via RBAC registry.',
      };
    }

    const previousRole = this.assignments.get(params.target_actor_id) ?? null;
    this.assignments.delete(params.target_actor_id);

    if (this.auditLogger) {
      const auditRes = this.auditLogger.logPermissionChange({
        actor_type: 'owner',
        actor_id: params.actor.actor_id,
        target_actor_id: params.target_actor_id,
        event_type: 'rbac.role.revoked',
        action: 'rbac:manage',
        outcome: 'success',
        correlation_id: params.correlation_id,
        metadata: { previous_role: previousRole },
      });
      if (!auditRes.ok) {
        if (previousRole) {
          this.assignments.set(params.target_actor_id, previousRole);
        }
        return {
          ok: false,
          code: 'AUDIT_STORAGE_FAILURE',
          error: `Role revocation rolled back due to audit failure: ${auditRes.error}`,
        };
      }
    }

    return { ok: true };
  }
}

export function principalToPolicyActor(principal: RbacPrincipal): PolicyActor {
  if (
    principal.authenticated === true &&
    principal.actor_type === 'owner' &&
    principal.role === 'owner'
  ) {
    return {
      id: principal.actor_id,
      type: 'owner',
      trusted_autonomy_level: 'L4',
      trusted_authenticated: true,
    };
  }

  const nonOwnerType =
    principal.actor_type === 'owner' || principal.actor_type === 'policy_engine'
      ? 'system'
      : principal.actor_type;

  return {
    id: principal.actor_id,
    type: nonOwnerType,
    trusted_autonomy_level:
      principal.role === 'agent_restricted' ? 'L2' : 'L0',
    trusted_authenticated: principal.authenticated,
  };
}

export function principalToTrustedReviewerContext(
  principal: RbacPrincipal,
): TrustedReviewerContext {
  return {
    actor_id: principal.actor_id,
    actor_type:
      principal.actor_type === 'owner' && principal.role === 'owner'
        ? 'owner'
        : principal.actor_type === 'agent'
          ? 'agent'
          : 'system',
    authenticated:
      principal.authenticated === true &&
      principal.actor_type === 'owner' &&
      principal.role === 'owner',
    auth_source: principal.auth_source,
  };
}
