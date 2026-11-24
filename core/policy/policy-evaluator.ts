import type {
  Approval,
  AutonomyLevel,
  ExecutionEnvironment,
} from '../../contracts/types/index.ts';
import { validateAgent, validateApproval } from '../../contracts/validation/index.ts';
import { validateSystemConfig } from '../configuration/validate-system-config.ts';
import type {
  AuditedPolicyEvaluationInput,
  PolicyActionDefinition,
  PolicyEvaluationInput,
  PolicyEvaluationResult,
} from './policy-types.ts';

const AUTONOMY_RANK: Record<AutonomyLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
};

const VALID_ENVIRONMENTS = new Set<ExecutionEnvironment>([
  'sandbox',
  'local',
  'staging',
  'production',
]);

const VALID_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/;

/**
 * Closed catalog of recognized TEJAURA policy actions.
 * Unknown actions always fail closed with `UNKNOWN_ACTION`.
 */
export const POLICY_ACTION_CATALOG: Readonly<
  Record<string, PolicyActionDefinition>
> = {
  'workspace:read': {
    action: 'workspace:read',
    required_autonomy: 'L0',
    required_scope: 'fs:read:workspace',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local', 'staging'],
    description: 'Read non-secret files within approved workspace paths.',
  },
  'governance:read': {
    action: 'governance:read',
    required_autonomy: 'L0',
    required_scope: 'governance:read',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local', 'staging', 'production'],
    description: 'Inspect governance and policy documents.',
  },
  'proposal:draft': {
    action: 'proposal:draft',
    required_autonomy: 'L1',
    required_scope: 'proposal:draft',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local', 'staging'],
    description: 'Draft a non-mutating plan or code diff for owner review.',
  },
  'sandbox:write': {
    action: 'sandbox:write',
    required_autonomy: 'L2',
    required_scope: 'fs:write:sandbox',
    owner_exclusive: false,
    allowed_environments: ['sandbox'],
    description: 'Write reversible temporary files strictly inside sandbox.',
  },
  'sandbox:execute': {
    action: 'sandbox:execute',
    required_autonomy: 'L2',
    required_scope: 'exec:run:sandbox',
    owner_exclusive: false,
    allowed_environments: ['sandbox'],
    description: 'Execute bounded local checks strictly inside sandbox.',
  },
  'agent:plan': {
    action: 'agent:plan',
    required_autonomy: 'L1',
    required_scope: 'agent:plan',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local', 'staging'],
    description: 'Analyze an objective and produce a bounded, non-mutating plan.',
  },
  'agent:delegate': {
    action: 'agent:delegate',
    required_autonomy: 'L2',
    required_scope: 'delegation:create',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local', 'staging'],
    description: 'Delegate validated child tasks to explicitly allowed department agents.',
  },
  'agent:write_code': {
    action: 'agent:write_code',
    required_autonomy: 'L2',
    required_scope: 'fs:write:sandbox',
    owner_exclusive: false,
    allowed_environments: ['sandbox'],
    description: 'Write bounded code changes only inside an isolated task workspace.',
  },
  'agent:test': {
    action: 'agent:test',
    required_autonomy: 'L2',
    required_scope: 'exec:run:sandbox',
    owner_exclusive: false,
    allowed_environments: ['sandbox'],
    description: 'Run an allowlisted test command inside an isolated task workspace.',
  },
  'agent:design': {
    action: 'agent:design',
    required_autonomy: 'L1',
    required_scope: 'design:write',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local'],
    description: 'Produce implementation-ready design specifications and reviews.',
  },
  'agent:seo_analyze': {
    action: 'agent:seo_analyze',
    required_autonomy: 'L1',
    required_scope: 'seo:analyze',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local'],
    description: 'Analyze supplied SEO context and produce recommendations.',
  },
  'agent:draft_content': {
    action: 'agent:draft_content',
    required_autonomy: 'L1',
    required_scope: 'content:draft',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local'],
    description: 'Draft non-published content and campaign material.',
  },
  'agent:support_draft': {
    action: 'agent:support_draft',
    required_autonomy: 'L1',
    required_scope: 'support:draft',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local'],
    description: 'Draft a support response without sending external communications.',
  },
  'agent:analyze': {
    action: 'agent:analyze',
    required_autonomy: 'L1',
    required_scope: 'analytics:read',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local'],
    description: 'Analyze supplied project metrics and produce a report.',
  },
  'agent:security_review': {
    action: 'agent:security_review',
    required_autonomy: 'L1',
    required_scope: 'security:review',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local'],
    description: 'Review supplied code and configuration for security risks.',
  },
  'agent:review': {
    action: 'agent:review',
    required_autonomy: 'L1',
    required_scope: 'review:write',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local'],
    description: 'Independently review outputs and acceptance criteria.',
  },
  'agent:research': {
    action: 'agent:research',
    required_autonomy: 'L1',
    required_scope: 'research:read',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local'],
    description: 'Synthesize supplied evidence into a bounded research brief.',
  },
  'agent:monitor': {
    action: 'agent:monitor',
    required_autonomy: 'L0',
    required_scope: 'ops:monitor',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local'],
    description: 'Read task and worker health and raise non-mutating alerts.',
  },
  'model:invoke_local': {
    action: 'model:invoke_local',
    required_autonomy: 'L2',
    required_scope: 'model:invoke:local',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local'],
    description: 'Invoke a registered, owner-enabled local open-source model.',
  },
  'external:api_call': {
    action: 'external:api_call',
    required_autonomy: 'L3',
    required_scope: 'net:egress:approved',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local', 'staging'],
    description: 'Call an approved external endpoint under owner supervision.',
  },
  'deploy:staging': {
    action: 'deploy:staging',
    required_autonomy: 'L3',
    required_scope: 'deploy:staging',
    owner_exclusive: false,
    allowed_environments: ['staging'],
    description: 'Deploy build artifacts to a non-production staging target.',
  },
  'model:discover': {
    action: 'model:discover',
    required_autonomy: 'L0',
    required_scope: 'model:discover:local',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local', 'staging'],
    description: 'Discover models exposed by a trusted owner-configured local runtime.',
  },
  'model:load': {
    action: 'model:load',
    required_autonomy: 'L2',
    required_scope: 'model:lifecycle:manage',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local'],
    description: 'Request loading an approved local model onto a controlled runtime.',
  },
  'model:unload': {
    action: 'model:unload',
    required_autonomy: 'L2',
    required_scope: 'model:lifecycle:manage',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local'],
    description: 'Request unloading an approved local model from a controlled runtime.',
  },
  'model:invoke_remote': {
    action: 'model:invoke_remote',
    required_autonomy: 'L3',
    required_scope: 'model:invoke:remote',
    owner_exclusive: false,
    allowed_environments: ['sandbox', 'local', 'staging'],
    description: 'Invoke a registered owner-controlled remote model under approval.',
  },
  'model:download': {
    action: 'model:download',
    required_autonomy: 'L3',
    required_scope: 'model:download:approved',
    owner_exclusive: false,
    allowed_environments: ['local', 'staging'],
    description: 'Download open-weight model artifacts (requires explicit owner approval).',
  },
  'runtime:manage': {
    action: 'runtime:manage',
    required_autonomy: 'L3',
    required_scope: 'runtime:manage:approved',
    owner_exclusive: false,
    allowed_environments: ['local', 'staging'],
    description: 'Start, stop, or reconfigure a controlled local model runtime (requires approval).',
  },
  'model:registry_write': {
    action: 'model:registry_write',
    required_autonomy: 'L4',
    required_scope: 'model:registry:write',
    owner_exclusive: true,
    allowed_environments: ['local', 'production'],
    description: 'Modify registered models or endpoints in the model registry (owner-only).',
  },
  'deploy:production': {
    action: 'deploy:production',
    required_autonomy: 'L4',
    required_scope: 'deploy:production',
    owner_exclusive: true,
    allowed_environments: ['production'],
    description: 'Deploy or modify a live production environment (owner-only).',
  },
  'billing:transact': {
    action: 'billing:transact',
    required_autonomy: 'L4',
    required_scope: 'billing:transact',
    owner_exclusive: true,
    allowed_environments: ['sandbox', 'local', 'staging', 'production'],
    description: 'Perform any payment, subscription, or billing action (owner-only).',
  },
  'publish:public': {
    action: 'publish:public',
    required_autonomy: 'L4',
    required_scope: 'publish:public',
    owner_exclusive: true,
    allowed_environments: ['production'],
    description: 'Publish content or packages to a public destination (owner-only).',
  },
  'governance:modify': {
    action: 'governance:modify',
    required_autonomy: 'L4',
    required_scope: 'governance:write',
    owner_exclusive: true,
    allowed_environments: ['local', 'production'],
    description: 'Modify constitution, permission policy, or system locks (owner-only).',
  },
  'permission:grant': {
    action: 'permission:grant',
    required_autonomy: 'L4',
    required_scope: 'governance:grant',
    owner_exclusive: true,
    allowed_environments: ['local', 'production'],
    description: 'Grant permissions or raise actor autonomy ceilings (owner-only).',
  },
  'approval:decide': {
    action: 'approval:decide',
    required_autonomy: 'L4',
    required_scope: 'approval:decide',
    owner_exclusive: true,
    allowed_environments: ['sandbox', 'local', 'staging', 'production'],
    description: 'Approve or reject sensitive approval requests (owner-only).',
  },
  'credential:access': {
    action: 'credential:access',
    required_autonomy: 'L4',
    required_scope: 'secrets:access',
    owner_exclusive: true,
    allowed_environments: ['local', 'staging', 'production'],
    description: 'Access or rotate credentials and secrets (owner-only).',
  },
  'auth:admin': {
    action: 'auth:admin',
    required_autonomy: 'L4',
    required_scope: 'auth:admin',
    owner_exclusive: true,
    allowed_environments: ['sandbox', 'local', 'staging', 'production'],
    description: 'Manage owner authentication, MFA/passkey enrollment, or session revocation (owner-only).',
  },
  'rbac:manage': {
    action: 'rbac:manage',
    required_autonomy: 'L4',
    required_scope: 'rbac:manage',
    owner_exclusive: true,
    allowed_environments: ['sandbox', 'local', 'staging', 'production'],
    description: 'Assign or revoke RBAC roles and permissions (owner-only).',
  },
  'data:delete': {
    action: 'data:delete',
    required_autonomy: 'L4',
    required_scope: 'data:delete',
    owner_exclusive: true,
    allowed_environments: ['sandbox', 'local', 'staging', 'production'],
    description: 'Delete persistent data or audit artifacts (owner-only).',
  },
};

function deny(
  reason_code: string,
  reason: string,
  required_approval_level: AutonomyLevel,
  policy_version: string,
): PolicyEvaluationResult {
  return {
    allowed: false,
    decision: 'deny',
    reason_code,
    reason,
    required_approval_level,
    policy_version,
  };
}

function requireApproval(
  reason_code: string,
  reason: string,
  required_approval_level: AutonomyLevel,
  policy_version: string,
): PolicyEvaluationResult {
  return {
    allowed: false,
    decision: 'require_approval',
    reason_code,
    reason,
    required_approval_level,
    policy_version,
  };
}

function minAutonomy(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return AUTONOMY_RANK[a] <= AUTONOMY_RANK[b] ? a : b;
}

function resolveNowMs(now: Date | string | undefined): number | null {
  if (now === undefined) {
    return Date.now();
  }
  const date = now instanceof Date ? now : new Date(now);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function hasWildcard(values: readonly string[]): boolean {
  return values.some((value) => value.includes('*'));
}

function validateApprovalForExecution(
  approval: Approval,
  input: PolicyEvaluationInput,
  requiredScope: string,
  requiredLevel: AutonomyLevel,
  policyVersion: string,
  nowMs: number,
): PolicyEvaluationResult | null {
  const contractCheck = validateApproval(approval);
  if (!contractCheck.valid) {
    return deny(
      'INVALID_APPROVAL_RECORD',
      `Approval record failed contract validation: ${contractCheck.errors.map((e) => e.message).join('; ')}`,
      requiredLevel,
      policyVersion,
    );
  }

  if (input.approval_consumed === true) {
    return deny(
      'SINGLE_USE_APPROVAL_CONSUMED',
      'Single-use approval has already been consumed.',
      requiredLevel,
      policyVersion,
    );
  }

  if (approval.status === 'rejected') {
    return deny(
      'APPROVAL_REJECTED',
      'Approval request was rejected by the owner.',
      requiredLevel,
      policyVersion,
    );
  }

  if (approval.status === 'expired') {
    return deny(
      'APPROVAL_EXPIRED',
      'Approval record has expired.',
      requiredLevel,
      policyVersion,
    );
  }

  if (approval.status === 'pending') {
    return requireApproval(
      'APPROVAL_PENDING',
      'Approval request is still pending human owner decision.',
      requiredLevel,
      policyVersion,
    );
  }

  if (
    approval.reviewed_by === null ||
    approval.reviewed_by === approval.requested_by ||
    approval.reviewed_by === input.actor.id ||
    /^agent([_.:-]|$)/i.test(approval.reviewed_by)
  ) {
    return deny(
      'AGENT_SELF_APPROVAL_FORBIDDEN',
      'Self-approval or agent-issued approval is strictly prohibited.',
      requiredLevel,
      policyVersion,
    );
  }

  if (approval.action !== input.action) {
    return deny(
      'APPROVAL_ACTION_MISMATCH',
      `Approval for action "${approval.action}" cannot authorize "${input.action}".`,
      requiredLevel,
      policyVersion,
    );
  }

  if (!approval.environment || approval.environment !== input.environment) {
    return deny(
      'APPROVAL_ENVIRONMENT_MISMATCH',
      `Approval environment "${approval.environment ?? 'unspecified'}" does not match "${input.environment}".`,
      requiredLevel,
      policyVersion,
    );
  }

  if (
    hasWildcard(approval.scope.resources) ||
    hasWildcard(approval.scope.permissions)
  ) {
    return deny(
      'WILDCARD_APPROVAL_SCOPE_FORBIDDEN',
      'Wildcard resources or permissions are not permitted in approval scopes.',
      requiredLevel,
      policyVersion,
    );
  }

  if (!approval.scope.resources.includes(input.resource.id)) {
    return deny(
      'APPROVAL_RESOURCE_MISMATCH',
      `Approval does not cover target resource "${input.resource.id}".`,
      requiredLevel,
      policyVersion,
    );
  }

  if (!approval.scope.permissions.includes(requiredScope)) {
    return deny(
      'APPROVAL_SCOPE_MISMATCH',
      `Approval does not grant required permission scope "${requiredScope}".`,
      requiredLevel,
      policyVersion,
    );
  }

  if (approval.scope.expires_at !== undefined && approval.scope.expires_at !== null) {
    const expiresMs = new Date(approval.scope.expires_at).getTime();
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
      return deny(
        'APPROVAL_EXPIRED',
        'Approval expiration timestamp has passed.',
        requiredLevel,
        policyVersion,
      );
    }
  }

  return null;
}

/**
 * Deterministic, fail-closed TEJAURA policy evaluator.
 *
 * TRUST BOUNDARY:
 * Callers MUST resolve `actor.trusted_autonomy_level`, `actor.trusted_authenticated`,
 * `actor.trusted_agent_record`, `declared_scopes`, and `approval` from trusted
 * host/store state—never directly from unvalidated agent-supplied claims.
 */
export function evaluatePolicy(
  input: PolicyEvaluationInput,
): PolicyEvaluationResult {
  const configValidation = validateSystemConfig(input?.system_config);
  if (!configValidation.valid) {
    return deny(
      'INVALID_SYSTEM_CONFIG',
      `System configuration is invalid (fail-closed): ${configValidation.errors.map((e) => e.message).join('; ')}`,
      'L4',
      'invalid',
    );
  }

  const config = configValidation.data;
  const policyVersion = config.schemaVersion;

  if (!input || typeof input !== 'object') {
    return deny(
      'MALFORMED_POLICY_INPUT',
      'Policy evaluation input must be an object.',
      'L4',
      policyVersion,
    );
  }

  const nowMs = resolveNowMs(input.now);
  if (nowMs === null) {
    return deny(
      'INVALID_CLOCK_TIMESTAMP',
      'Evaluation clock timestamp is invalid.',
      'L4',
      policyVersion,
    );
  }

  // Rule 2: Missing or malformed actor identity means deny.
  if (
    !input.actor ||
    typeof input.actor.id !== 'string' ||
    !VALID_ID_PATTERN.test(input.actor.id) ||
    !['owner', 'agent', 'system', 'adapter'].includes(input.actor.type)
  ) {
    return deny(
      'MISSING_OR_INVALID_ACTOR_IDENTITY',
      'Valid trusted actor identity is required.',
      'L4',
      policyVersion,
    );
  }

  if (!(input.actor.trusted_autonomy_level in AUTONOMY_RANK)) {
    return deny(
      'INVALID_AUTONOMY_LEVEL',
      'Trusted actor autonomy level is invalid.',
      'L4',
      policyVersion,
    );
  }

  // Rule 7: Non-owner actors can never hold L4 autonomy.
  if (
    input.actor.type !== 'owner' &&
    input.actor.trusted_autonomy_level === 'L4'
  ) {
    return deny(
      'AGENT_L4_AUTONOMY_FORBIDDEN',
      'Non-owner actors cannot hold L4 owner-exclusive autonomy.',
      'L4',
      policyVersion,
    );
  }

  let effectiveAutonomy: AutonomyLevel = input.actor.trusted_autonomy_level;

  if (input.actor.trusted_agent_record !== undefined) {
    const agentCheck = validateAgent(input.actor.trusted_agent_record);
    if (!agentCheck.valid) {
      return deny(
        'INVALID_AGENT_RECORD',
        'Trusted agent record failed contract validation.',
        'L4',
        policyVersion,
      );
    }

    const agentRecord = agentCheck.data;
    if (
      agentRecord.id !== input.actor.id ||
      !agentRecord.enabled ||
      agentRecord.status !== 'active'
    ) {
      return deny(
        'DISABLED_OR_MISMATCHED_AGENT',
        'Agent is disabled, inactive, or does not match actor identity.',
        'L4',
        policyVersion,
      );
    }

    effectiveAutonomy = minAutonomy(
      effectiveAutonomy,
      agentRecord.permitted_autonomy_level,
    );
  }

  // Validate resource & environment.
  if (
    !input.resource ||
    typeof input.resource.id !== 'string' ||
    input.resource.id.trim().length === 0 ||
    typeof input.resource.type !== 'string' ||
    input.resource.type.trim().length === 0
  ) {
    return deny(
      'MISSING_OR_INVALID_RESOURCE',
      'Target resource identity and type are required.',
      'L4',
      policyVersion,
    );
  }

  if (!VALID_ENVIRONMENTS.has(input.environment)) {
    return deny(
      'INVALID_ENVIRONMENT',
      `Unknown execution environment "${String(input.environment)}".`,
      'L4',
      policyVersion,
    );
  }

  // Rule 2 & 13: Missing scope or wildcard scope means deny.
  if (
    !Array.isArray(input.declared_scopes) ||
    input.declared_scopes.length === 0
  ) {
    return deny(
      'MISSING_DECLARED_SCOPES',
      'At least one explicit declared permission scope is required.',
      'L4',
      policyVersion,
    );
  }

  if (hasWildcard(input.declared_scopes)) {
    return deny(
      'WILDCARD_SCOPE_FORBIDDEN',
      'Wildcard permission scopes are forbidden by TEJAURA policy.',
      'L4',
      policyVersion,
    );
  }

  // Rule 3: Unknown actions mean deny.
  const actionSpec =
    typeof input.action === 'string'
      ? POLICY_ACTION_CATALOG[input.action]
      : undefined;

  if (!actionSpec) {
    return deny(
      'UNKNOWN_ACTION',
      `Action "${String(input.action)}" is not in the recognized policy catalog.`,
      'L4',
      policyVersion,
    );
  }

  // Rule 12: Environment boundaries (sandbox scopes never grant production).
  if (!actionSpec.allowed_environments.includes(input.environment)) {
    return deny(
      'ENVIRONMENT_NOT_PERMITTED',
      `Action "${actionSpec.action}" is not permitted in environment "${input.environment}".`,
      actionSpec.required_autonomy,
      policyVersion,
    );
  }

  if (
    input.environment === 'production' &&
    input.declared_scopes.every((scope) => scope.includes(':sandbox'))
  ) {
    return deny(
      'SANDBOX_SCOPE_CANNOT_AUTHORIZE_PRODUCTION',
      'Sandbox scopes cannot authorize production operations.',
      'L4',
      policyVersion,
    );
  }

  if (!input.declared_scopes.includes(actionSpec.required_scope)) {
    return deny(
      'MISSING_REQUIRED_SCOPE',
      `Missing required permission scope "${actionSpec.required_scope}".`,
      actionSpec.required_autonomy,
      policyVersion,
    );
  }

  // Rules 5, 6, 7, 9: Owner-exclusive L4 actions cannot be executed by agents.
  if (actionSpec.owner_exclusive || actionSpec.required_autonomy === 'L4') {
    if (input.actor.type !== 'owner') {
      const code =
        input.action === 'permission:grant' ||
        input.action === 'governance:modify'
          ? 'AGENT_SELF_PERMISSION_FORBIDDEN'
          : input.action === 'approval:decide'
            ? 'AGENT_SELF_APPROVAL_FORBIDDEN'
            : 'OWNER_EXCLUSIVE_ACTION_DENIED';

      return deny(
        code,
        `Action "${actionSpec.action}" is L4 owner-exclusive and cannot be executed by actor type "${input.actor.type}".`,
        'L4',
        policyVersion,
      );
    }

    if (input.actor.trusted_authenticated !== true) {
      return deny(
        'UNAUTHENTICATED_OWNER',
        'L4 owner-exclusive actions require an externally authenticated owner session.',
        'L4',
        policyVersion,
      );
    }

    if (input.approval) {
      const approvalFailure = validateApprovalForExecution(
        input.approval,
        input,
        actionSpec.required_scope,
        'L4',
        policyVersion,
        nowMs,
      );
      if (approvalFailure) {
        return approvalFailure;
      }
    } else if (input.owner_confirmed_l4 !== true) {
      return requireApproval(
        'OWNER_CONFIRMATION_REQUIRED',
        `L4 owner-exclusive action "${actionSpec.action}" requires explicit owner confirmation.`,
        'L4',
        policyVersion,
      );
    }

    return {
      allowed: true,
      decision: 'allow',
      reason_code: 'POLICY_ALLOW_OWNER_L4',
      reason: `Authenticated owner explicitly authorized L4 action "${actionSpec.action}".`,
      required_approval_level: 'L4',
      policy_version: policyVersion,
    };
  }

  // Autonomy ceiling check for L0-L3 actions.
  if (
    AUTONOMY_RANK[effectiveAutonomy] <
    AUTONOMY_RANK[actionSpec.required_autonomy]
  ) {
    return deny(
      'AUTONOMY_LEVEL_INSUFFICIENT',
      `Actor autonomy "${effectiveAutonomy}" is below required "${actionSpec.required_autonomy}" for "${actionSpec.action}".`,
      actionSpec.required_autonomy,
      policyVersion,
    );
  }

  // Rule 8, 10, 11: L3 actions require explicit, valid, matching owner approval.
  if (actionSpec.required_autonomy === 'L3') {
    if (!input.approval) {
      return requireApproval(
        'APPROVAL_REQUIRED',
        `L3 supervised action "${actionSpec.action}" requires explicit human owner approval.`,
        'L3',
        policyVersion,
      );
    }

    const approvalFailure = validateApprovalForExecution(
      input.approval,
      input,
      actionSpec.required_scope,
      'L3',
      policyVersion,
      nowMs,
    );
    if (approvalFailure) {
      return approvalFailure;
    }

    return {
      allowed: true,
      decision: 'allow',
      reason_code: 'POLICY_ALLOW_APPROVED_L3',
      reason: `L3 action "${actionSpec.action}" authorized by valid owner approval "${input.approval.id}".`,
      required_approval_level: 'L3',
      policy_version: policyVersion,
    };
  }

  // Unattended L2 ceiling from system.json check.
  if (
    AUTONOMY_RANK[actionSpec.required_autonomy] >
    AUTONOMY_RANK[config.governance.maxAutonomousLevel]
  ) {
    return requireApproval(
      'MAX_AUTONOMOUS_LEVEL_EXCEEDED',
      `Action "${actionSpec.action}" exceeds configured maxAutonomousLevel (${config.governance.maxAutonomousLevel}).`,
      actionSpec.required_autonomy,
      policyVersion,
    );
  }

  return {
    allowed: true,
    decision: 'allow',
    reason_code: 'POLICY_ALLOW',
    reason: `Action "${actionSpec.action}" allowed at ${actionSpec.required_autonomy} in "${input.environment}".`,
    required_approval_level: actionSpec.required_autonomy,
    policy_version: policyVersion,
  };
}

/**
 * Evaluates policy and records the decision to the audit logger.
 * Fails closed: if audit logging fails, authorization is denied even if policy matched.
 */
export function evaluatePolicyWithAudit(
  input: AuditedPolicyEvaluationInput,
): PolicyEvaluationResult {
  const result = evaluatePolicy(input);

  const actorType = input?.actor?.type ?? 'system';
  const actorId =
    input?.actor?.id && VALID_ID_PATTERN.test(input.actor.id)
      ? input.actor.id
      : 'unknown_actor';
  const resourceId =
    input?.resource?.id && input.resource.id.trim().length >= 2
      ? input.resource.id
      : 'unknown_resource';

  const auditResult = input.audit_logger.logPolicyDecision({
    actor_type: actorType,
    actor_id: actorId,
    resource_type: 'system',
    resource_id: resourceId,
    action: input.action || 'unknown_action',
    decision: result.decision,
    reason_code: result.reason_code,
    correlation_id: input.correlation_id,
    approval_id: input.approval?.id ?? null,
    metadata: {
      environment: input.environment,
      required_approval_level: result.required_approval_level,
      policy_version: result.policy_version,
    },
  });

  if (!auditResult.ok) {
    return deny(
      'AUDIT_STORAGE_FAILURE',
      `Authorization denied because audit logging failed: ${auditResult.error}`,
      result.required_approval_level,
      result.policy_version,
    );
  }

  return result;
}
