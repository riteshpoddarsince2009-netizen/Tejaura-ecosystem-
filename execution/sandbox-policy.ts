import fs from 'node:fs';
import path from 'node:path';

import type { Approval } from '../contracts/types/index.ts';
import { validateAgent, validateApproval, validateTool } from '../contracts/validation/index.ts';
import { toContractApproval, type ApprovalRecord } from '../core/approvals/index.ts';
import type { AuditLogger } from '../core/audit/index.ts';
import {
  POLICY_ACTION_CATALOG,
  evaluatePolicyWithAudit,
  type PolicyActor,
} from '../core/policy/index.ts';
import type {
  SandboxBrowserMode,
  SandboxNetworkMode,
} from '../control-plane/db/index.ts';
import type {
  SandboxPolicyConfig,
  SandboxValidationResult,
  SubmitAgentExecutionInput,
} from './execution-types.ts';

const FORBIDDEN_SYSTEM_ACTIONS_FOR_AGENTS = new Set([
  'permission:grant',
  'governance:modify',
  'approval:decide',
  'credential:access',
  'auth:admin',
  'rbac:manage',
  'data:delete',
  'model:registry_write',
]);

const FORBIDDEN_PATH_SEGMENTS = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.git',
  '.ssh',
  '.tejaura-state',
  'secrets',
  'node_modules',
]);

const FORBIDDEN_FILE_BASENAMES = new Set([
  'system.json',
  'tejaura_constitution.md',
  'permission_policy.md',
  'identity.enc.json',
  'secrets.vault.json',
  'dev-master.key',
]);

const BLOCKED_PAID_AI_HOSTS = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.cohere.ai',
  'api.mistral.ai',
  'api.groq.com',
  'api.together.xyz',
]);

const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
]);

const SHELL_TOOL_PATTERN =
  /(?:(?:^|[:_.-])(sh|zsh|csh|rsh|cmd)(?:$|[:_.-])|(shell|bash|powershell)|exec:(?:arbitrary|shell))/i;

const VALID_RESOURCE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/;

function isInsideDirectory(candidateResolved: string, rootResolved: string): boolean {
  const normalizedRoot = rootResolved.endsWith(path.sep)
    ? rootResolved
    : `${rootResolved}${path.sep}`;
  return candidateResolved === rootResolved || candidateResolved.startsWith(normalizedRoot);
}

function resolveRealAncestorOrSelf(targetPath: string): string | null {
  let cursor = targetPath;
  while (true) {
    if (fs.existsSync(cursor)) {
      try {
        return fs.realpathSync(cursor);
      } catch {
        return null;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return null;
    }
    cursor = parent;
  }
}

function validateRequestedPaths(
  requestedPaths: readonly string[],
  policyConfig: SandboxPolicyConfig,
  declaredScopes: readonly string[],
): { ok: true; normalized: string[] } | { ok: false; code: string; reason: string } {
  if (requestedPaths.length === 0) {
    return { ok: true, normalized: [] };
  }

  const hasFsScope = declaredScopes.some(
    (s) => s === 'fs:read:workspace' || s === 'fs:write:sandbox',
  );
  if (!hasFsScope) {
    return {
      ok: false,
      code: 'FILESYSTEM_SCOPE_REQUIRED',
      reason:
        'Filesystem access requested without an explicit fs:read:workspace or fs:write:sandbox scope.',
    };
  }

  const resolvedRoot = path.resolve(policyConfig.workspaceRoot);
  const realRoot = resolveRealAncestorOrSelf(resolvedRoot) ?? resolvedRoot;
  const configuredAllowlist = (policyConfig.allowedRelativePaths ?? []).map((p) =>
    path.resolve(resolvedRoot, p),
  );

  if (configuredAllowlist.length === 0) {
    return {
      ok: false,
      code: 'FILESYSTEM_ALLOWLIST_EMPTY',
      reason:
        'Default-deny: no workspace paths are allowlisted for this sandbox execution.',
    };
  }

  const normalized: string[] = [];
  for (const rawPath of requestedPaths) {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      return {
        ok: false,
        code: 'INVALID_FILESYSTEM_PATH',
        reason: 'Requested filesystem path must be a non-empty relative path.',
      };
    }

    const trimmed = rawPath.trim();
    if (
      trimmed.includes('\0') ||
      path.isAbsolute(trimmed) ||
      trimmed.startsWith('~') ||
      trimmed.split(/[\\/]/).includes('..')
    ) {
      return {
        ok: false,
        code: 'PATH_TRAVERSAL_OR_ABSOLUTE_FORBIDDEN',
        reason: `Path "${trimmed}" is blocked: absolute paths, "~", and ".." traversal are forbidden.`,
      };
    }

    const segments = trimmed.split(/[\\/]/).filter(Boolean);
    const lowerSegments = segments.map((s) => s.toLowerCase());
    if (
      lowerSegments.some(
        (s) => FORBIDDEN_PATH_SEGMENTS.has(s) || s.startsWith('.env'),
      ) ||
      FORBIDDEN_FILE_BASENAMES.has(lowerSegments[lowerSegments.length - 1] ?? '')
    ) {
      return {
        ok: false,
        code: 'PROTECTED_PATH_FORBIDDEN',
        reason: `Path "${trimmed}" targets a protected governance, secret, or environment file.`,
      };
    }

    const resolvedTarget = path.resolve(resolvedRoot, trimmed);
    if (!isInsideDirectory(resolvedTarget, resolvedRoot)) {
      return {
        ok: false,
        code: 'WORKSPACE_BOUNDARY_VIOLATION',
        reason: `Resolved path "${trimmed}" escapes configured sandbox workspace root.`,
      };
    }

    const realTargetAncestor = resolveRealAncestorOrSelf(resolvedTarget);
    if (!realTargetAncestor || !isInsideDirectory(realTargetAncestor, realRoot)) {
      return {
        ok: false,
        code: 'SYMLINK_ESCAPE_FORBIDDEN',
        reason: `Path "${trimmed}" resolves outside the sandbox workspace root.`,
      };
    }

    const insideAllowlist = configuredAllowlist.some((allowed) =>
      isInsideDirectory(resolvedTarget, allowed),
    );
    if (!insideAllowlist) {
      return {
        ok: false,
        code: 'PATH_NOT_IN_ALLOWLIST',
        reason: `Path "${trimmed}" is outside explicit sandbox path allowlist.`,
      };
    }

    normalized.push(path.relative(resolvedRoot, resolvedTarget) || '.');
  }

  return { ok: true, normalized };
}

function validateUrlAllowlist(
  urls: readonly string[],
  modeLabel: 'network' | 'browser',
): { ok: true; urls: string[] } | { ok: false; code: string; reason: string } {
  if (urls.length === 0) {
    return {
      ok: false,
      code:
        modeLabel === 'network'
          ? 'NETWORK_ALLOWLIST_EMPTY'
          : 'BROWSER_ALLOWLIST_EMPTY',
      reason: `Allowlisted ${modeLabel} access requires at least one explicit non-wildcard URL.`,
    };
  }

  const normalized: string[] = [];
  for (const raw of urls) {
    if (typeof raw !== 'string' || raw.includes('*')) {
      return {
        ok: false,
        code: 'WILDCARD_URL_FORBIDDEN',
        reason: `Wildcard or non-string ${modeLabel} allowlist targets are forbidden.`,
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return {
        ok: false,
        code: 'INVALID_ALLOWLIST_URL',
        reason: `Invalid ${modeLabel} URL "${raw}".`,
      };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return {
        ok: false,
        code: 'UNSUPPORTED_URL_SCHEME',
        reason: `Unsupported URL scheme "${parsed.protocol}" in ${modeLabel} allowlist.`,
      };
    }

    const host = parsed.hostname.toLowerCase();
    if (BLOCKED_PAID_AI_HOSTS.has(host)) {
      return {
        ok: false,
        code: 'PAID_THIRD_PARTY_AI_API_FORBIDDEN',
        reason: `Paid third-party AI API host "${host}" is strictly forbidden by TEJAURA architecture.`,
      };
    }
    if (BLOCKED_METADATA_HOSTS.has(host)) {
      return {
        ok: false,
        code: 'METADATA_HOST_FORBIDDEN',
        reason: `Cloud metadata host "${host}" is forbidden.`,
      };
    }

    if (modeLabel === 'browser' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        code: 'BROWSER_HTTPS_REQUIRED',
        reason: 'Allowlisted browser access requires https:// URLs.',
      };
    }

    normalized.push(parsed.toString());
  }

  return { ok: true, urls: normalized };
}

function failValidation(
  decision: 'deny' | 'require_approval',
  reason_code: string,
  reason: string,
): SandboxValidationResult {
  return {
    allowed: false,
    decision,
    reason_code,
    reason,
    normalized_allowed_paths: [],
    network_mode: 'none',
    network_allowlist: [],
    browser_mode: 'disabled',
    browser_allowlist: [],
    resolved_approval: null,
  };
}

export function validateSandboxExecution(params: {
  input: SubmitAgentExecutionInput;
  initiator: PolicyActor;
  policyConfig: SandboxPolicyConfig;
  systemConfig: unknown;
  auditLogger: AuditLogger;
  correlationId: string;
  approvalRecord: ApprovalRecord | Approval | null;
  now: Date;
}): SandboxValidationResult {
  const { input, initiator, policyConfig, approvalRecord } = params;

  // 1. Always block arbitrary shell commands or direct shell invocation.
  if (
    typeof input.requested_shell_command === 'string' &&
    input.requested_shell_command.trim().length > 0
  ) {
    return failValidation(
      'deny',
      'SHELL_EXECUTION_FORBIDDEN',
      'Arbitrary shell command execution is strictly prohibited in TEJAURA.',
    );
  }

  if (
    typeof input.resource_id !== 'string' ||
    !VALID_RESOURCE_ID_PATTERN.test(input.resource_id)
  ) {
    return failValidation(
      'deny',
      'INVALID_RESOURCE_ID',
      'Target resource_id must match ^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$.',
    );
  }

  // 2. Validate Agent contract strictly (rejects L4, disabled/paused agents, secret fields).
  const agentCheck = validateAgent(input.agent);
  if (!agentCheck.valid) {
    return failValidation(
      'deny',
      'INVALID_AGENT_CONTRACT',
      `Agent failed contract validation: ${agentCheck.errors.map((e) => e.message).join('; ')}`,
    );
  }
  const agent = agentCheck.data;
  if (!agent.enabled || agent.status !== 'active') {
    return failValidation(
      'deny',
      'AGENT_DISABLED_OR_INACTIVE',
      `Agent "${agent.id}" is ${agent.status} (enabled=${agent.enabled}) and cannot execute tasks.`,
    );
  }

  // 3. Reject agent-initiated privilege escalation or owner-only security mutations.
  if (
    initiator.type === 'agent' &&
    FORBIDDEN_SYSTEM_ACTIONS_FOR_AGENTS.has(input.requested_action)
  ) {
    const code =
      input.requested_action === 'permission:grant' ||
      input.requested_action === 'governance:modify'
        ? 'AGENT_SELF_PERMISSION_FORBIDDEN'
        : input.requested_action === 'approval:decide'
          ? 'AGENT_SELF_APPROVAL_FORBIDDEN'
          : 'AGENT_PRIVILEGE_ESCALATION_FORBIDDEN';
    return failValidation(
      'deny',
      code,
      `Agents are strictly forbidden from executing "${input.requested_action}".`,
    );
  }

  // 4. Validate every requested Tool against contract, enabled status, agent allowlist, and task scopes.
  if (!Array.isArray(input.tools) || input.tools.length === 0) {
    return failValidation(
      'deny',
      'MISSING_REGISTERED_TOOLS',
      'At least one explicit registered tool must be declared for agent execution.',
    );
  }

  for (const rawTool of input.tools) {
    const toolCheck = validateTool(rawTool);
    if (!toolCheck.valid) {
      return failValidation(
        'deny',
        'INVALID_TOOL_CONTRACT',
        `Tool failed contract validation: ${toolCheck.errors.map((e) => e.message).join('; ')}`,
      );
    }
    const tool = toolCheck.data;
    if (!tool.enabled) {
      return failValidation(
        'deny',
        'TOOL_DISABLED',
        `Tool "${tool.id}" is disabled.`,
      );
    }
    if (
      SHELL_TOOL_PATTERN.test(tool.id) ||
      SHELL_TOOL_PATTERN.test(tool.permission_scope)
    ) {
      return failValidation(
        'deny',
        'SHELL_EXECUTION_FORBIDDEN',
        `Shell tool "${tool.id}" is forbidden inside the sandbox execution engine.`,
      );
    }
    if (!agent.allowed_tool_ids.includes(tool.id)) {
      return failValidation(
        'deny',
        'TOOL_NOT_ALLOWED_FOR_AGENT',
        `Agent "${agent.id}" is not permitted to invoke tool "${tool.id}".`,
      );
    }
    if (tool.permission_scope.includes('*')) {
      return failValidation(
        'deny',
        'WILDCARD_SCOPE_FORBIDDEN',
        `Tool "${tool.id}" declares forbidden wildcard permission scope.`,
      );
    }
    if (!input.declared_scopes.includes(tool.permission_scope)) {
      return failValidation(
        'deny',
        'TOOL_SCOPE_NOT_DECLARED',
        `Execution request is missing declared scope "${tool.permission_scope}" required by tool "${tool.id}".`,
      );
    }
  }

  // 5. Enforce filesystem allowlist & containment.
  const fsCheck = validateRequestedPaths(
    input.requested_paths ?? [],
    policyConfig,
    input.declared_scopes,
  );
  if (!fsCheck.ok) {
    return failValidation('deny', fsCheck.code, fsCheck.reason);
  }

  // 6. Enforce network & browser default-deny boundaries.
  if (input.requested_network_mode === 'unrestricted') {
    return failValidation(
      'deny',
      'UNRESTRICTED_NETWORK_FORBIDDEN',
      'Unrestricted network access is strictly forbidden in TEJAURA sandboxes.',
    );
  }
  const networkMode: SandboxNetworkMode =
    input.requested_network_mode ?? policyConfig.defaultNetworkMode ?? 'none';
  let networkAllowlist: string[] = [];
  if (networkMode === 'allowlisted_endpoints') {
    const netUrlCheck = validateUrlAllowlist(
      input.requested_network_urls ?? [],
      'network',
    );
    if (!netUrlCheck.ok) {
      return failValidation('deny', netUrlCheck.code, netUrlCheck.reason);
    }
    if (!input.declared_scopes.includes('net:egress:approved')) {
      return failValidation(
        'deny',
        'NETWORK_EGRESS_SCOPE_REQUIRED',
        'Allowlisted network egress requires explicit "net:egress:approved" scope.',
      );
    }
    networkAllowlist = netUrlCheck.urls;
  }

  if (input.requested_browser_mode === 'unrestricted') {
    return failValidation(
      'deny',
      'UNRESTRICTED_BROWSER_FORBIDDEN',
      'Unrestricted browser access is strictly forbidden in TEJAURA sandboxes.',
    );
  }
  const browserMode: SandboxBrowserMode =
    input.requested_browser_mode ?? policyConfig.defaultBrowserMode ?? 'disabled';
  let browserAllowlist: string[] = [];
  if (browserMode === 'read_only_allowlisted') {
    const browserUrlCheck = validateUrlAllowlist(
      input.requested_browser_urls ?? [],
      'browser',
    );
    if (!browserUrlCheck.ok) {
      return failValidation('deny', browserUrlCheck.code, browserUrlCheck.reason);
    }
    if (!input.declared_scopes.includes('net:egress:approved')) {
      return failValidation(
        'deny',
        'BROWSER_EGRESS_SCOPE_REQUIRED',
        'Allowlisted browser access requires explicit "net:egress:approved" scope.',
      );
    }
    browserAllowlist = browserUrlCheck.urls;
  }

  const actionSpec = POLICY_ACTION_CATALOG[input.requested_action];
  const isOwnerExclusive =
    actionSpec?.owner_exclusive === true ||
    actionSpec?.required_autonomy === 'L4';

  const contractApproval: Approval | null = approvalRecord
    ? 'consumed_at' in approvalRecord
      ? toContractApproval(approvalRecord)
      : approvalRecord
    : null;

  const alreadyConsumed =
    approvalRecord !== null &&
    'consumed_at' in approvalRecord &&
    approvalRecord.consumed_at !== null &&
    approvalRecord.scope.single_use;

  // Egress, high/critical risk tools, or L4 owner-exclusive actions may never bypass owner approval.
  const usesEgress =
    networkMode !== 'none' || browserMode !== 'disabled';
  const usesElevatedTool = input.tools.some(
    (t) =>
      t.risk_level === 'high' ||
      t.risk_level === 'critical' ||
      t.category === 'deployment' ||
      t.category === 'billing' ||
      t.category === 'publishing' ||
      t.category === 'network',
  );
  if (usesEgress || usesElevatedTool || isOwnerExclusive) {
    if (!approvalRecord || !contractApproval) {
      return failValidation(
        'require_approval',
        'APPROVAL_REQUIRED',
        'Network/browser egress, elevated-risk tools, and owner-exclusive actions require explicit human owner approval.',
      );
    }
    const approvalContractCheck = validateApproval(contractApproval);
    if (!approvalContractCheck.valid) {
      return failValidation(
        'deny',
        'INVALID_APPROVAL_RECORD',
        `Approval record failed contract validation: ${approvalContractCheck.errors.map((e) => e.message).join('; ')}`,
      );
    }

    if (alreadyConsumed) {
      return failValidation(
        'deny',
        'SINGLE_USE_APPROVAL_CONSUMED',
        'Single-use approval has already been consumed.',
      );
    }
    if (approvalRecord.status !== 'approved') {
      return failValidation(
        approvalRecord.status === 'pending' ? 'require_approval' : 'deny',
        approvalRecord.status === 'pending'
          ? 'APPROVAL_PENDING'
          : `APPROVAL_${approvalRecord.status.toUpperCase()}`,
        `Elevated execution approval is "${approvalRecord.status}", not "approved".`,
      );
    }
    if (
      approvalRecord.reviewed_by === null ||
      approvalRecord.reviewed_by === approvalRecord.requested_by ||
      approvalRecord.reviewed_by === agent.id ||
      (initiator.type === 'agent' && approvalRecord.reviewed_by === initiator.id) ||
      /^agent([_.:-]|$)/i.test(approvalRecord.reviewed_by)
    ) {
      return failValidation(
        'deny',
        'AGENT_SELF_APPROVAL_FORBIDDEN',
        'Self-approval or agent-issued approval is strictly prohibited.',
      );
    }
    if (approvalRecord.environment !== input.environment) {
      return failValidation(
        'deny',
        'APPROVAL_ENVIRONMENT_MISMATCH',
        `Approval environment "${approvalRecord.environment ?? 'unspecified'}" does not match "${input.environment}".`,
      );
    }
    if (approvalRecord.action !== input.requested_action) {
      return failValidation(
        'deny',
        'APPROVAL_ACTION_MISMATCH',
        `Approval action "${approvalRecord.action}" does not match "${input.requested_action}".`,
      );
    }
    if (
      approvalRecord.scope.resources.some((r) => r.includes('*')) ||
      approvalRecord.scope.permissions.some((p) => p.includes('*'))
    ) {
      return failValidation(
        'deny',
        'WILDCARD_APPROVAL_SCOPE_FORBIDDEN',
        'Wildcard resources or permissions are not permitted in approval scopes.',
      );
    }
    if (!approvalRecord.scope.resources.includes(input.resource_id)) {
      return failValidation(
        'deny',
        'APPROVAL_RESOURCE_MISMATCH',
        `Approval does not cover target resource "${input.resource_id}".`,
      );
    }
    const requiredScope =
      actionSpec?.required_scope ?? input.declared_scopes[0];
    if (
      requiredScope &&
      !approvalRecord.scope.permissions.includes(requiredScope)
    ) {
      return failValidation(
        'deny',
        'APPROVAL_SCOPE_MISMATCH',
        `Approval does not grant required permission scope "${requiredScope}".`,
      );
    }
    if (
      approvalRecord.scope.expires_at !== undefined &&
      approvalRecord.scope.expires_at !== null
    ) {
      const expiresMs = new Date(approvalRecord.scope.expires_at).getTime();
      if (!Number.isFinite(expiresMs) || expiresMs <= params.now.getTime()) {
        return failValidation(
          'deny',
          'APPROVAL_EXPIRED',
          'Approval expiration timestamp has passed.',
        );
      }
    }
  }

  // 7. Determine effective PolicyActor & evaluate Stage 1 policy engine with audit logging.
  const evalActor: PolicyActor =
    initiator.type === 'owner'
      ? {
          id: initiator.id,
          type: 'owner',
          trusted_autonomy_level: initiator.trusted_autonomy_level,
          trusted_authenticated: initiator.trusted_authenticated === true,
        }
      : {
          id: agent.id,
          type: 'agent',
          trusted_autonomy_level: agent.permitted_autonomy_level,
          trusted_authenticated: initiator.trusted_authenticated,
          trusted_agent_record: agent,
        };

  // For owner-initiated L4 actions backed by an owner-approved Approval Inbox record
  // requested by the agent, avoid Stage 1's actor===reviewed_by collision while still
  // enforcing L4 owner authentication, scope, environment, and audit logging.
  const ownerBackedL4Approval =
    isOwnerExclusive &&
    initiator.type === 'owner' &&
    contractApproval !== null;

  const policyResult = evaluatePolicyWithAudit({
    actor: evalActor,
    action: input.requested_action,
    resource: {
      id: input.resource_id,
      type: 'agent_execution',
    },
    environment: input.environment,
    declared_scopes: input.declared_scopes,
    approval: ownerBackedL4Approval ? null : contractApproval,
    approval_consumed: alreadyConsumed,
    owner_confirmed_l4:
      isOwnerExclusive && initiator.type === 'owner'
        ? input.owner_confirmed_l4 === true || contractApproval !== null
        : undefined,
    system_config: params.systemConfig,
    audit_logger: params.auditLogger,
    correlation_id: params.correlationId,
    now: params.now,
  });

  if (!policyResult.allowed) {
    return {
      allowed: false,
      decision: policyResult.decision,
      reason_code: policyResult.reason_code,
      reason: policyResult.reason,
      normalized_allowed_paths: [],
      network_mode: 'none',
      network_allowlist: [],
      browser_mode: 'disabled',
      browser_allowlist: [],
      resolved_approval: approvalRecord,
    };
  }

  return {
    allowed: true,
    decision: 'allow',
    reason_code: policyResult.reason_code,
    reason: policyResult.reason,
    normalized_allowed_paths: fsCheck.normalized,
    network_mode: networkMode,
    network_allowlist: networkAllowlist,
    browser_mode: browserMode,
    browser_allowlist: browserAllowlist,
    resolved_approval: approvalRecord,
  };
}
