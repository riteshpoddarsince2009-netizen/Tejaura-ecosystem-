import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Agent, Approval, ExecutionEnvironment } from '../../contracts/types/index.ts';
import { validateAgent } from '../../contracts/validation/index.ts';
import { toContractApproval, type ApprovalRecord, type ApprovalService, type TrustedReviewerContext } from '../../core/approvals/index.ts';
import {
  InMemoryAuditStorage,
  JsonlAuditStorage,
  type AuditLogger,
  type AuditStorage,
} from '../../core/audit/index.ts';
import {
  evaluatePolicyWithAudit,
  type PolicyActor,
} from '../../core/policy/index.ts';
import type { HardwareManager } from '../../intelligence/hardware/index.ts';
import type {
  LocalModelEntry,
  LocalModelRegistry,
} from '../../intelligence/model-registry/local-model-registry.ts';
import {
  RuntimeManager,
  validateControlledEndpointUrl,
  type LocalRuntimeType,
  type TrustedRuntimeEndpoint,
} from '../../intelligence/runtime/index.ts';
import type {
  ManagedAgentDepartment,
  ManagedAgentRecord,
  ManagedAgentStatus,
  ManagedModelRecord,
  ManagedModelSource,
  ManagedProjectDeploymentStatus,
  ManagedProjectRecord,
  ManagedProjectType,
  ManagedWorkerRecord,
  OrchestrationStore,
  SystemBackupRecord,
} from '../db/index.ts';

const VALID_DEPARTMENTS = new Set<ManagedAgentDepartment>([
  'research',
  'engineering',
  'seo',
  'design',
  'content',
  'analytics',
  'customer_support',
]);

const VALID_AGENT_STATUSES = new Set<ManagedAgentStatus>([
  'active',
  'paused',
  'disabled',
  'retired',
]);

const VALID_MODEL_SOURCES = new Set<ManagedModelSource>([
  'modelscope',
  'huggingface',
  'local_mirror',
  'owner_archive',
]);

const VALID_RUNTIME_TYPES = new Set<LocalRuntimeType>([
  'airllm',
  'ollama',
  'llama_cpp',
  'vllm',
  'sglang',
  'openai_compatible_local',
]);

const VALID_PROJECT_TYPES = new Set<ManagedProjectType>([
  'website',
  'web_app',
  'api_service',
  'automation',
]);

const VALID_ENVIRONMENTS = new Set<ExecutionEnvironment>([
  'sandbox',
  'local',
  'staging',
  'production',
]);

const MANAGEMENT_EXECUTOR_ID = 'system:management_control_plane';

const VALID_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/;
const VALID_ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const SECRET_FIELD_PATTERN =
  /(secret|password|passphrase|api_?key|access_?token|refresh_?token|bearer_?token|auth_?token|private_?key|master_?key|allow_self_permission|allow_self_approval|can_self_approve)/i;

export interface ManagementActorContext {
  actor: PolicyActor;
  correlation_id: string;
}

export interface ManagementResult<T> {
  ok: true;
  data: T;
}

export interface ManagementError {
  ok: false;
  code: string;
  error: string;
  http_status: number;
  /** Present when a restricted action is waiting for a real owner decision. */
  approval?: ApprovalRecord;
}

export type ManagementOutcome<T> = ManagementResult<T> | ManagementError;

export interface UnifiedLogEntry {
  log_id: string;
  source: 'audit' | 'task_event' | 'agent_execution';
  severity: 'info' | 'warn' | 'error';
  timestamp: string;
  actor_id: string;
  action: string;
  outcome: string;
  resource_id: string;
  message: string;
}

export interface ManagementSystemConfig {
  maintenance_mode: boolean;
  max_queue_depth: number;
  auto_recover_leases: boolean;
  preferred_model_source: ManagedModelSource;
  default_model_id: string | null;
  backup_model_id: string | null;
}

export interface ManagementServiceOptions {
  store: OrchestrationStore;
  registry: LocalModelRegistry;
  hardware: HardwareManager;
  runtime: RuntimeManager;
  auditLogger: AuditLogger;
  auditStorage: AuditStorage;
  approvalsProvider: () => ApprovalService;
  systemConfig: unknown;
  stateDir: string;
  clock?: () => Date;
}

function sanitizeErrorString(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/(token|secret|password|key)=[^\s&]+/gi, '$1=[REDACTED]')
    .slice(0, 300);
}

function hasForbiddenControlKeys(obj: Record<string, unknown>): string | null {
  for (const key of Object.keys(obj)) {
    if (key === 'auth_token_env_var') continue;
    if (SECRET_FIELD_PATTERN.test(key)) {
      return key;
    }
  }
  return null;
}

function validateSafeRelativePaths(pathsInput: unknown): {
  ok: true;
  paths: string[];
} | { ok: false; error: string } {
  if (!Array.isArray(pathsInput)) {
    return { ok: true, paths: ['sandbox'] };
  }
  const clean: string[] = [];
  for (const item of pathsInput) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (
      path.isAbsolute(trimmed) ||
      trimmed.includes('..') ||
      trimmed.includes('\0') ||
      trimmed.startsWith('~')
    ) {
      return {
        ok: false,
        error: `Path "${trimmed}" must be a relative workspace path without ".." traversal.`,
      };
    }
    clean.push(trimmed.slice(0, 180));
  }
  return { ok: true, paths: clean.length > 0 ? [...new Set(clean)] : ['sandbox'] };
}

function computeDirectoryBytes(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += computeDirectoryBytes(full);
    } else if (entry.isFile()) {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

function toContractAgent(record: ManagedAgentRecord): Agent {
  return {
    id: record.id,
    name: record.name,
    department: record.department,
    role: record.role,
    description: record.description,
    status: record.status,
    enabled: record.enabled,
    permitted_autonomy_level: record.permitted_autonomy_level,
    allowed_tool_ids: [...record.allowed_tool_ids],
    preferred_model_ids: [...record.preferred_model_ids],
    created_at: record.created_at,
    schema_version: record.schema_version,
  };
}

export class ManagementService {
  private readonly store: OrchestrationStore;
  private readonly registry: LocalModelRegistry;
  private readonly hardware: HardwareManager;
  private readonly runtime: RuntimeManager;
  private readonly auditLogger: AuditLogger;
  private readonly auditStorage: AuditStorage;
  private readonly approvalsProvider: () => ApprovalService;
  private readonly systemConfig: unknown;
  private readonly stateDir: string;
  private readonly backupsDir: string;
  private readonly clock: () => Date;

  constructor(options: ManagementServiceOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.hardware = options.hardware;
    this.runtime = options.runtime;
    this.auditLogger = options.auditLogger;
    this.auditStorage = options.auditStorage;
    this.approvalsProvider = options.approvalsProvider;
    this.systemConfig = options.systemConfig;
    this.stateDir = path.resolve(options.stateDir);
    this.backupsDir = path.join(this.stateDir, 'backups');
    this.clock = options.clock ?? (() => new Date());
  }

  private managementExecutor(): PolicyActor {
    return {
      id: MANAGEMENT_EXECUTOR_ID,
      type: 'system',
      trusted_autonomy_level: 'L3',
      trusted_authenticated: true,
    };
  }

  private runtimeApprovalTaskId(resourceId: string): string {
    return `${MANAGEMENT_EXECUTOR_ID}:${resourceId}`.slice(0, 128);
  }

  /**
   * Restricted runtime actions are authorized only by a real owner decision
   * recorded in the Approval Inbox. Without an approval id we create a pending
   * request and stop; we never fabricate an owner or decide on the owner's behalf.
   */
  private obtainRuntimeApproval(params: {
    resourceId: string;
    requiredScope: string;
    approvalId?: string;
    ctx: ManagementActorContext;
  }): { ok: true; approval: Approval } | ManagementError {
    const approvals = this.approvalsProvider();
    const taskId = this.runtimeApprovalTaskId(params.resourceId);

    if (!params.approvalId) {
      const existingPending = approvals
        .listApprovals()
        .find(
          (record) =>
            record.task_id === taskId &&
            record.action === 'runtime:manage' &&
            record.status === 'pending' &&
            record.scope.resources.includes(params.resourceId) &&
            record.scope.permissions.includes(params.requiredScope),
        );
      if (existingPending) {
        return {
          ok: false,
          code: 'APPROVAL_REQUIRED',
          error:
            'Owner approval is required before this runtime action can proceed. Approve it in the Owner Approval Inbox and retry with approval_id.',
          http_status: 202,
          approval: existingPending,
        };
      }

      const reqRes = approvals.requestApproval({
        task_id: taskId,
        action: 'runtime:manage',
        requested_by: MANAGEMENT_EXECUTOR_ID,
        reason: `Owner approval requested for runtime action on "${params.resourceId}".`,
        scope: {
          resources: [params.resourceId],
          permissions: [params.requiredScope],
          single_use: true,
          expires_at: new Date(
            this.clock().getTime() + 60 * 60 * 1000,
          ).toISOString(),
        },
        environment: 'local',
        correlation_id: params.ctx.correlation_id,
      });
      if (!reqRes.ok) {
        return {
          ok: false,
          code: reqRes.code,
          error: reqRes.error,
          http_status: 400,
        };
      }
      return {
        ok: false,
        code: 'APPROVAL_REQUIRED',
        error:
          'Owner approval is required before this runtime action can proceed. Approve it in the Owner Approval Inbox and retry with approval_id.',
        http_status: 202,
        approval: reqRes.record,
      };
    }

    const consumed = approvals.verifyAndConsumeApproval({
      approval_id: params.approvalId,
      task_id: taskId,
      action: 'runtime:manage',
      resource_id: params.resourceId,
      required_scope: params.requiredScope,
      environment: 'local',
      actor_id: MANAGEMENT_EXECUTOR_ID,
      correlation_id: params.ctx.correlation_id,
    });
    if (!consumed.ok) {
      return {
        ok: false,
        code: consumed.code,
        error: consumed.error,
        http_status: 403,
      };
    }

    return { ok: true, approval: toContractApproval(consumed.record) };
  }

  private assertOwnerMutation(
    ctx: ManagementActorContext,
    action: string,
    resourceType: 'agent' | 'model' | 'configuration' | 'task' | 'system' | 'governance',
    resourceId: string,
  ): ManagementError | null {
    if (
      !ctx.actor ||
      ctx.actor.type !== 'owner' ||
      !ctx.actor.trusted_authenticated ||
      /^agent([_.:-]|$)/i.test(ctx.actor.id)
    ) {
      this.auditLogger.logPolicyDecision({
        actor_type: ctx.actor?.type ?? 'system',
        actor_id: ctx.actor?.id || 'unauthenticated',
        resource_type: resourceType,
        resource_id: resourceId,
        action,
        decision: 'deny',
        reason_code: 'OWNER_AUTHORIZATION_REQUIRED',
        correlation_id: ctx.correlation_id,
      });
      return {
        ok: false,
        code: 'OWNER_AUTHORIZATION_REQUIRED',
        error: 'Management mutation requires an authenticated human owner.',
        http_status: 403,
      };
    }
    return null;
  }

  private auditManagementEvent(params: {
    ctx: ManagementActorContext;
    event_type: string;
    resource_type: 'agent' | 'model' | 'configuration' | 'task' | 'system' | 'governance';
    resource_id: string;
    action: string;
    outcome: 'success' | 'failure' | 'denied' | 'pending';
    metadata?: Record<string, unknown>;
  }): boolean {
    const res = this.auditLogger.logEvent({
      actor_type: 'owner',
      actor_id: params.ctx.actor.id,
      event_type: params.event_type,
      resource_type: params.resource_type,
      resource_id: params.resource_id,
      action: params.action,
      outcome: params.outcome,
      correlation_id: params.ctx.correlation_id,
      metadata: params.metadata ?? {},
    });
    return res.ok;
  }

  /**
   * Synchronize persisted SQLite models & workers with in-memory LocalModelRegistry
   * and RuntimeManager on startup and after backup restores.
   */
  syncFromPersistenceOnStartup(): void {
    const nowIso = this.clock().toISOString();

    // 1. Seed initial models from LocalModelRegistry into SQLite if missing,
    // and push SQLite models back into LocalModelRegistry.
    const dbModels = this.store.listManagedModels({ limit: 250 }).items;
    const dbModelMap = new Map(dbModels.map((m) => [m.model_id, m]));

    for (const regModel of this.registry.listModels()) {
      if (!dbModelMap.has(regModel.model_id)) {
        const seeded = this.store.saveManagedModel({
          model_id: regModel.model_id,
          model_name: regModel.model_name,
          model_family: regModel.model_family,
          model_version: regModel.model_version,
          source: regModel.model_repository.source,
          repo_id: regModel.model_repository.repo_id,
          revision: regModel.model_repository.revision,
          local_model_path: regModel.local_model_path,
          controlled_runtime_endpoint: regModel.controlled_runtime_endpoint,
          runtime_type: regModel.runtime_type,
          compatibility_status: regModel.compatibility_status,
          modality: regModel.modality as any,
          capabilities: [...regModel.capabilities],
          hardware_requirements: { ...regModel.hardware_requirements },
          quantization: regModel.quantization,
          context_length: regModel.context_length,
          size_mb: regModel.size_mb ?? 0,
          format: regModel.format ?? 'safetensors',
          install_status: regModel.local_model_path
            ? 'installed_unverified'
            : 'not_installed',
          verified_on_disk: false,
          is_default: dbModels.length === 0 && regModel.runtime_type === 'airllm',
          is_backup: false,
          enabled: regModel.enabled,
          availability: regModel.availability,
          license: { ...regModel.license },
          node_id: regModel.node_id ?? null,
          last_verified_at: null,
          last_error: null,
          created_at: nowIso,
          updated_at: nowIso,
        });
        dbModelMap.set(seeded.model_id, seeded);
      }
    }

    // Rehydrate models that were persisted only after an authenticated owner
    // mutation. This startup path never creates an owner identity or approval.
    const missingModels = [...dbModelMap.values()].filter(
      (m) => !this.registry.getModel(m.model_id),
    );
    if (missingModels.length > 0) {
      const restore = this.registry.restorePersistedModels(
        missingModels.map((m) => this.toLocalModelEntry(m)),
      );
      this.auditLogger.logEvent({
        actor_type: 'system',
        actor_id: 'system:persistence_sync',
        event_type: 'model.registry.rehydrated',
        resource_type: 'model',
        resource_id: 'model_registry',
        action: 'model:registry_rehydrate',
        outcome: restore.rejected.length === 0 ? 'success' : 'failure',
        correlation_id: 'corr_bootstrap_model_sync',
        metadata: {
          restored: restore.restored,
          rejected: restore.rejected,
        },
      });
    }

    // 2. Seed initial TrustedEndpoints from RuntimeManager into SQLite if missing,
    // and rehydrate persisted workers without fabricating owner approval.
    const dbWorkers = this.store.listManagedWorkers({ limit: 250 }).items;
    const dbWorkerMap = new Map(dbWorkers.map((w) => [w.worker_id, w]));

    for (const ep of this.runtime.listTrustedEndpoints()) {
      if (!dbWorkerMap.has(ep.endpoint_id)) {
        const seeded = this.store.saveManagedWorker({
          worker_id: ep.endpoint_id,
          name: ep.endpoint_id,
          runtime_type: ep.runtime_type,
          node_id: ep.node_id,
          base_url: ep.base_url,
          requires_auth: ep.requires_auth ?? true,
          auth_token_env_var: ep.auth_token_env_var ?? null,
          enabled: ep.enabled,
          health_status: 'unknown',
          current_model_id: null,
          active_jobs: 0,
          queue_length: 0,
          latency_ms: null,
          discovered_models: [],
          last_checked_at: null,
          last_error: null,
          created_at: nowIso,
          updated_at: nowIso,
        });
        dbWorkerMap.set(seeded.worker_id, seeded);
      }
    }

    const knownEndpoints = new Set(
      this.runtime.listTrustedEndpoints().map((ep) => ep.endpoint_id),
    );
    const workersToRestore = [...dbWorkerMap.values()].filter(
      (w) =>
        !knownEndpoints.has(w.worker_id) &&
        VALID_RUNTIME_TYPES.has(w.runtime_type as LocalRuntimeType),
    );

    if (workersToRestore.length > 0) {
      const restore = this.runtime.restorePersistedEndpoints(
        workersToRestore.map((w) => ({
          endpoint_id: w.worker_id,
          runtime_type: w.runtime_type as LocalRuntimeType,
          base_url: w.base_url,
          node_id: w.node_id,
          enabled: w.enabled,
          requires_auth: w.requires_auth,
          auth_token_env_var: w.auth_token_env_var ?? undefined,
        })),
      );

      for (const rejection of restore.rejected) {
        const worker = dbWorkerMap.get(rejection.endpoint_id);
        if (worker) {
          this.store.saveManagedWorker({
            ...worker,
            health_status: 'offline',
            last_error: `Persisted endpoint could not be restored: ${rejection.error}`,
            updated_at: nowIso,
          });
        }
      }

      this.auditLogger.logEvent({
        actor_type: 'system',
        actor_id: 'system:persistence_sync',
        event_type: 'runtime.endpoints.rehydrated',
        resource_type: 'system',
        resource_id: 'runtime_manager',
        action: 'runtime:rehydrate',
        outcome: restore.rejected.length === 0 ? 'success' : 'failure',
        correlation_id: 'corr_bootstrap_worker_sync',
        metadata: {
          restored: restore.restored,
          rejected: restore.rejected,
        },
      });
    }
  }

  private toLocalModelEntry(m: ManagedModelRecord): LocalModelEntry {
    return {
      model_id: m.model_id,
      model_name: m.model_name,
      model_family: m.model_family,
      model_version: m.model_version,
      model_repository: {
        repo_id: m.repo_id,
        revision: m.revision,
        source: m.source,
      },
      local_model_path: m.local_model_path,
      controlled_runtime_endpoint: m.controlled_runtime_endpoint,
      runtime_type: (VALID_RUNTIME_TYPES.has(m.runtime_type as LocalRuntimeType)
        ? m.runtime_type
        : 'airllm') as LocalRuntimeType,
      compatibility_status: m.compatibility_status,
      modality: m.modality as any,
      capabilities: [...m.capabilities] as LocalModelEntry['capabilities'],
      hardware_requirements: { ...m.hardware_requirements },
      quantization: m.quantization,
      context_length: m.context_length,
      enabled: m.enabled,
      availability: (
        m.availability === 'available' ||
        m.availability === 'loading' ||
        m.availability === 'unavailable' ||
        m.availability === 'offline' ||
        m.availability === 'error'
          ? m.availability
          : 'unavailable'
      ) as LocalModelEntry['availability'],
      license: { ...m.license },
      size_mb: m.size_mb,
      format: m.format as LocalModelEntry['format'],
      node_id: m.node_id ?? undefined,
    };
  }

  // ==================== B. AGENT MANAGEMENT ====================

  listAgents(filter?: {
    department?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): { items: ManagedAgentRecord[]; total: number } {
    const dept =
      filter?.department && VALID_DEPARTMENTS.has(filter.department as ManagedAgentDepartment)
        ? (filter.department as ManagedAgentDepartment)
        : undefined;
    const status =
      filter?.status && VALID_AGENT_STATUSES.has(filter.status as ManagedAgentStatus)
        ? (filter.status as ManagedAgentStatus)
        : undefined;
    return this.store.listManagedAgents({
      department: dept,
      status,
      limit: filter?.limit,
      offset: filter?.offset,
    });
  }

  createOrUpdateAgent(
    rawInput: Record<string, unknown>,
    ctx: ManagementActorContext,
    existingId?: string,
  ): ManagementOutcome<ManagedAgentRecord> {
    const authErr = this.assertOwnerMutation(
      ctx,
      existingId ? 'agent:update' : 'agent:create',
      'agent',
      existingId ?? (typeof rawInput.id === 'string' ? rawInput.id : 'new_agent'),
    );
    if (authErr) return authErr;

    const forbiddenKey = hasForbiddenControlKeys(rawInput);
    if (forbiddenKey) {
      return {
        ok: false,
        code: 'FORBIDDEN_AGENT_FIELD',
        error: `Field "${forbiddenKey}" cannot be set on an agent definition.`,
        http_status: 400,
      };
    }

    if (rawInput.permitted_autonomy_level === 'L4') {
      return {
        ok: false,
        code: 'AGENT_L4_FORBIDDEN',
        error: 'L4 autonomy is permanently reserved for the human owner and cannot be assigned to agents.',
        http_status: 403,
      };
    }

    const existing = existingId ? this.store.getManagedAgent(existingId) : null;
    if (existingId && !existing) {
      return {
        ok: false,
        code: 'AGENT_NOT_FOUND',
        error: `Agent "${existingId}" was not found.`,
        http_status: 404,
      };
    }

    const id = existingId
      ? existingId
      : typeof rawInput.id === 'string' && rawInput.id.trim().length > 0
        ? rawInput.id.trim()
        : `agent_${crypto.randomUUID().slice(0, 8)}`;

    if (!VALID_ID_PATTERN.test(id)) {
      return {
        ok: false,
        code: 'INVALID_AGENT_ID',
        error: 'Agent ID must be 2-128 alphanumeric, dot, underscore, colon, or hyphen characters.',
        http_status: 400,
      };
    }

    const department = (
      rawInput.department ?? existing?.department ?? ''
    ) as ManagedAgentDepartment;
    if (!VALID_DEPARTMENTS.has(department)) {
      return {
        ok: false,
        code: 'INVALID_AGENT_DEPARTMENT',
        error: `Department must be one of: ${[...VALID_DEPARTMENTS].join(', ')}.`,
        http_status: 400,
      };
    }

    const name =
      typeof rawInput.name === 'string'
        ? rawInput.name.trim()
        : existing?.name ?? '';
    const role =
      typeof rawInput.role === 'string'
        ? rawInput.role.trim()
        : existing?.role ?? '';
    const description =
      typeof rawInput.description === 'string'
        ? rawInput.description.trim()
        : existing?.description ?? '';

    const status = (
      rawInput.status ?? existing?.status ?? 'active'
    ) as ManagedAgentStatus;
    if (!VALID_AGENT_STATUSES.has(status)) {
      return {
        ok: false,
        code: 'INVALID_AGENT_STATUS',
        error: 'Agent status must be active, paused, disabled, or retired.',
        http_status: 400,
      };
    }

    const enabled =
      typeof rawInput.enabled === 'boolean'
        ? rawInput.enabled
        : existing
          ? existing.enabled
          : status === 'active';

    const autonomy = (
      rawInput.permitted_autonomy_level ??
      existing?.permitted_autonomy_level ??
      'L1'
    ) as ManagedAgentRecord['permitted_autonomy_level'];

    const toolIds = Array.isArray(rawInput.allowed_tool_ids)
      ? [
          ...new Set(
            rawInput.allowed_tool_ids
              .filter((t): t is string => typeof t === 'string' && t.trim().length >= 2)
              .map((t) => t.trim()),
          ),
        ]
      : existing?.allowed_tool_ids ?? ['workspace.read'];

    const preferredModels = Array.isArray(rawInput.preferred_model_ids)
      ? [
          ...new Set(
            rawInput.preferred_model_ids
              .filter((m): m is string => typeof m === 'string' && m.trim().length >= 2)
              .map((m) => m.trim()),
          ),
        ]
      : existing?.preferred_model_ids ?? [];

    const backupModels = Array.isArray(rawInput.backup_model_ids)
      ? [
          ...new Set(
            rawInput.backup_model_ids
              .filter((m): m is string => typeof m === 'string' && m.trim().length >= 2)
              .map((m) => m.trim()),
          ),
        ]
      : existing?.backup_model_ids ?? [];

    const pathCheck = validateSafeRelativePaths(
      rawInput.allowed_paths ?? existing?.allowed_paths ?? ['sandbox'],
    );
    if (!pathCheck.ok) {
      return {
        ok: false,
        code: 'INVALID_AGENT_PATHS',
        error: pathCheck.error,
        http_status: 400,
      };
    }

    const maxConcurrent =
      typeof rawInput.max_concurrent_jobs === 'number' &&
      Number.isFinite(rawInput.max_concurrent_jobs)
        ? Math.min(10, Math.max(1, Math.round(rawInput.max_concurrent_jobs)))
        : existing?.max_concurrent_jobs ?? 1;

    const timeoutMs =
      typeof rawInput.timeout_ms === 'number' && Number.isFinite(rawInput.timeout_ms)
        ? Math.min(300_000, Math.max(500, Math.round(rawInput.timeout_ms)))
        : existing?.timeout_ms ?? 30_000;

    const networkMode =
      rawInput.network_mode === 'allowlisted_endpoints' ||
      rawInput.network_mode === 'none'
        ? rawInput.network_mode
        : existing?.network_mode ?? 'none';

    const nowIso = this.clock().toISOString();
    const candidate: ManagedAgentRecord = {
      id,
      name,
      department,
      role,
      description,
      status,
      enabled,
      permitted_autonomy_level: autonomy,
      allowed_tool_ids: toolIds,
      preferred_model_ids: preferredModels,
      backup_model_ids: backupModels,
      max_concurrent_jobs: maxConcurrent,
      timeout_ms: timeoutMs,
      allowed_paths: pathCheck.paths,
      network_mode: networkMode,
      last_health_status: existing?.last_health_status ?? 'healthy',
      created_by: existing?.created_by ?? ctx.actor.id,
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
      schema_version: '1.0.0',
    };

    const contractCheck = validateAgent(toContractAgent(candidate));
    if (!contractCheck.valid) {
      return {
        ok: false,
        code: 'INVALID_AGENT_CONTRACT',
        error: contractCheck.errors.map((e) => e.message).join('; '),
        http_status: 400,
      };
    }

    if (
      !this.auditManagementEvent({
        ctx,
        event_type: existing ? 'agent.updated' : 'agent.created',
        resource_type: 'agent',
        resource_id: candidate.id,
        action: existing ? 'agent:update' : 'agent:create',
        outcome: 'success',
        metadata: {
          department: candidate.department,
          permitted_autonomy_level: candidate.permitted_autonomy_level,
          status: candidate.status,
          enabled: candidate.enabled,
        },
      })
    ) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Agent update aborted because audit logging failed.',
        http_status: 500,
      };
    }

    const saved = this.store.saveManagedAgent(candidate);
    return { ok: true, data: saved };
  }

  setAgentStatus(
    agentId: string,
    status: ManagedAgentStatus,
    enabled: boolean,
    ctx: ManagementActorContext,
  ): ManagementOutcome<ManagedAgentRecord> {
    const authErr = this.assertOwnerMutation(ctx, 'agent:status', 'agent', agentId);
    if (authErr) return authErr;

    if (!VALID_AGENT_STATUSES.has(status)) {
      return {
        ok: false,
        code: 'INVALID_AGENT_STATUS',
        error: 'Status must be active, paused, disabled, or retired.',
        http_status: 400,
      };
    }

    const existing = this.store.getManagedAgent(agentId);
    if (!existing) {
      return {
        ok: false,
        code: 'AGENT_NOT_FOUND',
        error: `Agent "${agentId}" was not found.`,
        http_status: 404,
      };
    }

    const nextEnabled = status === 'active' ? enabled : false;
    const updated: ManagedAgentRecord = {
      ...existing,
      status,
      enabled: nextEnabled,
      updated_at: this.clock().toISOString(),
    };

    if (
      !this.auditManagementEvent({
        ctx,
        event_type: 'agent.status.updated',
        resource_type: 'agent',
        resource_id: agentId,
        action: 'agent:status',
        outcome: 'success',
        metadata: { status, enabled: nextEnabled },
      })
    ) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Agent status change aborted because audit logging failed.',
        http_status: 500,
      };
    }

    return { ok: true, data: this.store.saveManagedAgent(updated) };
  }

  getAgentHistory(agentId: string): ManagementOutcome<{
    agent: ManagedAgentRecord;
    jobs: ReturnType<OrchestrationStore['listAgentExecutionJobs']>;
    logs: ReturnType<OrchestrationStore['listAgentExecutionLogs']>;
  }> {
    const agent = this.store.getManagedAgent(agentId);
    if (!agent) {
      return {
        ok: false,
        code: 'AGENT_NOT_FOUND',
        error: `Agent "${agentId}" was not found.`,
        http_status: 404,
      };
    }
    return {
      ok: true,
      data: {
        agent,
        jobs: this.store.listAgentExecutionJobs({ agentId, limit: 50 }),
        logs: this.store.listAgentExecutionLogs({ agentId, limit: 100 }),
      },
    };
  }

  // ==================== C. MODEL MANAGEMENT ====================

  listManagedModels(filter?: {
    runtimeType?: string;
    source?: ManagedModelSource;
    limit?: number;
    offset?: number;
  }) {
    const paged = this.store.listManagedModels(filter);
    const enriched = paged.items.map((m) => {
      const regEntry = this.registry.getModel(m.model_id) ?? this.toLocalModelEntry(m);
      return {
        ...m,
        model_repository: {
          repo_id: m.repo_id,
          revision: m.revision,
          source: m.source,
        },
        breaker: this.registry.getModel(m.model_id)
          ? { consecutive_failures: 0, circuit_open: false }
          : { consecutive_failures: 0, circuit_open: false },
        best_node_fit: this.hardware.findBestCompatibleNode(regEntry).fit,
      };
    });
    return {
      items: enriched,
      total: paged.total,
    };
  }

  addOrUpdateModel(
    rawInput: Record<string, unknown>,
    ctx: ManagementActorContext,
    existingModelId?: string,
  ): ManagementOutcome<ManagedModelRecord> {
    const authErr = this.assertOwnerMutation(
      ctx,
      'model:registry_write',
      'model',
      existingModelId ?? (typeof rawInput.model_id === 'string' ? rawInput.model_id : 'new_model'),
    );
    if (authErr) return authErr;

    const forbiddenKey = hasForbiddenControlKeys(rawInput);
    if (forbiddenKey) {
      return {
        ok: false,
        code: 'SECRET_FIELD_FORBIDDEN',
        error: `Secret-like field "${forbiddenKey}" cannot be stored in model registry.`,
        http_status: 400,
      };
    }

    const existing = existingModelId
      ? this.store.getManagedModel(existingModelId)
      : null;
    if (existingModelId && !existing) {
      return {
        ok: false,
        code: 'MODEL_NOT_FOUND',
        error: `Model "${existingModelId}" was not found.`,
        http_status: 404,
      };
    }

    const modelId = existingModelId
      ? existingModelId
      : typeof rawInput.model_id === 'string'
        ? rawInput.model_id.trim()
        : '';
    if (!VALID_ID_PATTERN.test(modelId)) {
      return {
        ok: false,
        code: 'INVALID_MODEL_ID',
        error: 'Valid model_id (2-128 safe characters) is required.',
        http_status: 400,
      };
    }

    const source = (
      rawInput.source ?? existing?.source ?? 'modelscope'
    ) as ManagedModelSource;
    if (!VALID_MODEL_SOURCES.has(source)) {
      return {
        ok: false,
        code: 'INVALID_MODEL_SOURCE',
        error: 'Source must be modelscope, huggingface, local_mirror, or owner_archive.',
        http_status: 400,
      };
    }

    const runtimeType = (
      rawInput.runtime_type ?? existing?.runtime_type ?? 'airllm'
    ) as LocalRuntimeType;
    if (!VALID_RUNTIME_TYPES.has(runtimeType)) {
      return {
        ok: false,
        code: 'INVALID_RUNTIME_TYPE',
        error: `Unsupported runtime_type "${String(runtimeType)}".`,
        http_status: 400,
      };
    }

    const endpoint =
      rawInput.controlled_runtime_endpoint === null
        ? null
        : typeof rawInput.controlled_runtime_endpoint === 'string' &&
            rawInput.controlled_runtime_endpoint.trim().length > 0
          ? rawInput.controlled_runtime_endpoint.trim()
          : existing?.controlled_runtime_endpoint ?? null;

    if (endpoint !== null) {
      const epCheck = validateControlledEndpointUrl(endpoint);
      if (!epCheck.valid) {
        return {
          ok: false,
          code: epCheck.code ?? 'FORBIDDEN_ENDPOINT',
          error: epCheck.error ?? 'Forbidden controlled runtime endpoint.',
          http_status: 400,
        };
      }
    }

    const localPath =
      rawInput.local_model_path === null
        ? null
        : typeof rawInput.local_model_path === 'string' &&
            rawInput.local_model_path.trim().length > 0
          ? rawInput.local_model_path.trim()
          : existing?.local_model_path ?? null;

    const modelName =
      typeof rawInput.model_name === 'string'
        ? rawInput.model_name.trim()
        : existing?.model_name ?? '';
    const modelFamily =
      typeof rawInput.model_family === 'string'
        ? rawInput.model_family.trim()
        : existing?.model_family ?? 'qwen2.5';
    const modelVersion =
      typeof rawInput.model_version === 'string'
        ? rawInput.model_version.trim()
        : existing?.model_version ?? '1.0';
    const repoId =
      typeof rawInput.repo_id === 'string'
        ? rawInput.repo_id.trim()
        : existing?.repo_id ?? modelId;
    const revision =
      typeof rawInput.revision === 'string' && rawInput.revision.trim().length > 0
        ? rawInput.revision.trim()
        : existing?.revision ?? 'main';

    if (!modelName || !repoId) {
      return {
        ok: false,
        code: 'MISSING_MODEL_FIELDS',
        error: 'model_name and repo_id are required.',
        http_status: 400,
      };
    }

    const compatibility =
      rawInput.compatibility_status === 'verified' ||
      rawInput.compatibility_status === 'untested' ||
      rawInput.compatibility_status === 'unsupported'
        ? rawInput.compatibility_status
        : existing?.compatibility_status ?? 'untested';

    const requestedEnabled =
      typeof rawInput.enabled === 'boolean'
        ? rawInput.enabled
        : existing?.enabled ?? false;

    const sizeMb =
      typeof rawInput.size_mb === 'number' && Number.isFinite(rawInput.size_mb)
        ? Math.max(0, Math.round(rawInput.size_mb))
        : existing?.size_mb ?? 0;

    const format =
      typeof rawInput.format === 'string' && rawInput.format.trim().length > 0
        ? rawInput.format.trim().slice(0, 40)
        : existing?.format ?? 'safetensors';

    const quantization =
      typeof rawInput.quantization === 'string' && rawInput.quantization.trim().length > 0
        ? rawInput.quantization.trim().slice(0, 40)
        : existing?.quantization ?? '4bit';

    const contextLength =
      typeof rawInput.context_length === 'number' && Number.isFinite(rawInput.context_length)
        ? Math.min(1_048_576, Math.max(512, Math.round(rawInput.context_length)))
        : existing?.context_length ?? 32768;

    const capabilities = Array.isArray(rawInput.capabilities)
      ? rawInput.capabilities.filter((c): c is string => typeof c === 'string')
      : existing?.capabilities ?? ['chat', 'reasoning'];

    const nowIso = this.clock().toISOString();
    // Fail-honest: newly added models are never marked verified_on_disk until verifyModelInstall runs.
    const verifiedOnDisk = existing?.verified_on_disk ?? false;
    const installStatus = existing?.install_status ?? 'not_installed';

    const candidate: ManagedModelRecord = {
      model_id: modelId,
      model_name: modelName,
      model_family: modelFamily,
      model_version: modelVersion,
      source,
      repo_id: repoId,
      revision,
      local_model_path: localPath,
      controlled_runtime_endpoint: endpoint,
      runtime_type: runtimeType,
      compatibility_status: compatibility,
      modality: (rawInput.modality ?? existing?.modality ?? 'text') as ManagedModelRecord['modality'],
      capabilities,
      hardware_requirements: existing?.hardware_requirements ?? {
        min_ram_mb: 4096,
        min_vram_mb: 0,
        min_storage_mb: Math.max(512, sizeMb || 1024),
        requires_gpu: false,
      },
      quantization,
      context_length: contextLength,
      size_mb: sizeMb,
      format,
      install_status: installStatus,
      verified_on_disk: verifiedOnDisk,
      is_default: existing?.is_default ?? false,
      is_backup: existing?.is_backup ?? false,
      enabled: requestedEnabled,
      availability:
        existing?.availability === 'available' ||
        existing?.availability === 'loading' ||
        existing?.availability === 'unavailable' ||
        existing?.availability === 'offline' ||
        existing?.availability === 'error'
          ? existing.availability
          : 'unavailable',
      license: {
        name:
          typeof rawInput.license_name === 'string' && rawInput.license_name.trim()
            ? rawInput.license_name.trim()
            : existing?.license.name ?? 'Apache-2.0',
        spdx_id:
          typeof rawInput.spdx_id === 'string' && rawInput.spdx_id.trim()
            ? rawInput.spdx_id.trim()
            : existing?.license.spdx_id ?? 'Apache-2.0',
        open_weight: true,
        commercial_use_allowed: true,
      },
      node_id: existing?.node_id ?? 'local_host_airllm',
      last_verified_at: existing?.last_verified_at ?? null,
      last_error: existing?.last_error ?? null,
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
    };

    const regRes = this.registry.registerModel(this.toLocalModelEntry(candidate), {
      actor: ctx.actor,
      declared_scopes: ['model:registry:write'],
      system_config: this.systemConfig,
      audit_logger: this.auditLogger,
      correlation_id: ctx.correlation_id,
    });
    if (!regRes.ok) {
      return {
        ok: false,
        code: regRes.code,
        error: regRes.error,
        http_status: 400,
      };
    }

    const saved = this.store.saveManagedModel(candidate);
    return { ok: true, data: saved };
  }

  toggleModel(
    modelId: string,
    enabled: boolean,
    ctx: ManagementActorContext,
  ): ManagementOutcome<ManagedModelRecord> {
    const authErr = this.assertOwnerMutation(ctx, 'model:registry_write', 'model', modelId);
    if (authErr) return authErr;

    const existing = this.store.getManagedModel(modelId);
    if (!existing) {
      return {
        ok: false,
        code: 'MODEL_NOT_FOUND',
        error: `Model "${modelId}" was not found.`,
        http_status: 404,
      };
    }

    const regRes = this.registry.setEnabled(modelId, enabled, {
      actor: ctx.actor,
      declared_scopes: ['model:registry:write'],
      system_config: this.systemConfig,
      audit_logger: this.auditLogger,
      correlation_id: ctx.correlation_id,
    });
    if (!regRes.ok) {
      return {
        ok: false,
        code: regRes.code,
        error: regRes.error,
        http_status: 400,
      };
    }

    const saved = this.store.saveManagedModel({
      ...existing,
      enabled,
      updated_at: this.clock().toISOString(),
    });
    return { ok: true, data: saved };
  }

  setModelRole(
    modelId: string,
    role: 'default' | 'backup',
    ctx: ManagementActorContext,
  ): ManagementOutcome<ManagedModelRecord> {
    const authErr = this.assertOwnerMutation(ctx, 'model:registry_write', 'model', modelId);
    if (authErr) return authErr;

    const existing = this.store.getManagedModel(modelId);
    if (!existing) {
      return {
        ok: false,
        code: 'MODEL_NOT_FOUND',
        error: `Model "${modelId}" was not found.`,
        http_status: 404,
      };
    }
    if (existing.compatibility_status === 'unsupported') {
      return {
        ok: false,
        code: 'MODEL_UNSUPPORTED',
        error: `Unsupported model "${modelId}" cannot be assigned as ${role}.`,
        http_status: 400,
      };
    }

    const nowIso = this.clock().toISOString();
    const updated = this.store.setManagedModelRole(modelId, role, nowIso);
    if (!updated) {
      return {
        ok: false,
        code: 'MODEL_NOT_FOUND',
        error: `Model "${modelId}" was not found.`,
        http_status: 404,
      };
    }

    this.store.setSystemConfigEntry({
      config_key: role === 'default' ? 'default_model_id' : 'backup_model_id',
      config_value: modelId,
      updated_at: nowIso,
      updated_by: ctx.actor.id,
    });

    this.auditManagementEvent({
      ctx,
      event_type: 'model.role.assigned',
      resource_type: 'model',
      resource_id: modelId,
      action: 'model:set_role',
      outcome: 'success',
      metadata: { role },
    });

    return { ok: true, data: updated };
  }

  async verifyModelInstall(
    modelId: string,
    ctx: ManagementActorContext,
  ): Promise<ManagementOutcome<ManagedModelRecord>> {
    const authErr = this.assertOwnerMutation(ctx, 'model:verify_install', 'model', modelId);
    if (authErr) return authErr;

    const existing = this.store.getManagedModel(modelId);
    if (!existing) {
      return {
        ok: false,
        code: 'MODEL_NOT_FOUND',
        error: `Model "${modelId}" was not found.`,
        http_status: 404,
      };
    }

    const nowIso = this.clock().toISOString();
    let verifiedOnDisk = false;
    let runtimeAvailable = false;
    let detailsError: string | null = null;

    if (existing.local_model_path) {
      const candidatePath = existing.local_model_path.trim();
      // Only inspect safe relative paths or explicit non-traversal model paths
      if (candidatePath.includes('..') || candidatePath.includes('\0')) {
        detailsError = 'Rejected unsafe local_model_path containing traversal.';
      } else {
        const resolved = path.isAbsolute(candidatePath)
          ? path.resolve(candidatePath)
          : path.resolve(process.cwd(), candidatePath);
        if (fs.existsSync(resolved)) {
          const stat = fs.statSync(resolved);
          if (stat.isFile() && stat.size > 0) {
            verifiedOnDisk = true;
          } else if (stat.isDirectory()) {
            const entries = fs.readdirSync(resolved);
            verifiedOnDisk = entries.length > 0;
            if (!verifiedOnDisk) {
              detailsError = 'Model directory exists but contains no weight files.';
            }
          }
        } else {
          detailsError = `Model artifacts were not found on disk at "${existing.local_model_path}".`;
        }
      }
    }

    // Also check if a controlled worker runtime actively exposes this model
    if (
      VALID_RUNTIME_TYPES.has(existing.runtime_type as LocalRuntimeType)
    ) {
      const endpoints = this.runtime
        .listTrustedEndpoints()
        .filter((e) => e.enabled && e.runtime_type === existing.runtime_type);
      for (const ep of endpoints) {
        try {
          const disc = await this.runtime.discoverModels(
            ep.runtime_type,
            ep.base_url,
            { timeoutMs: 3000 },
          );
          if (
            disc.ok &&
            disc.models.some(
              (m) => m.model_name === existing.model_id || m.model_name === existing.repo_id,
            )
          ) {
            runtimeAvailable = true;
            break;
          }
        } catch {
          // Honest offline failure recorded below
        }
      }
    }

    const verified = verifiedOnDisk || runtimeAvailable;
    const installStatus = verified
      ? 'verified'
      : existing.local_model_path
        ? 'not_installed'
        : 'not_installed';
    const availability: ManagedModelRecord['availability'] = runtimeAvailable
      ? 'available'
      : verifiedOnDisk
        ? 'unavailable'
        : 'offline';

    this.registry.updateAvailability(modelId, availability as any);

    const updated = this.store.saveManagedModel({
      ...existing,
      install_status: installStatus,
      verified_on_disk: verifiedOnDisk,
      availability,
      last_verified_at: nowIso,
      last_error: verified ? null : detailsError ?? 'No local files or active runtime detected for this model.',
      updated_at: nowIso,
    });

    this.auditManagementEvent({
      ctx,
      event_type: 'model.install.verified',
      resource_type: 'model',
      resource_id: modelId,
      action: 'model:verify_install',
      outcome: verified ? 'success' : 'failure',
      metadata: {
        verified_on_disk: verifiedOnDisk,
        runtime_available: runtimeAvailable,
        install_status: installStatus,
      },
    });

    return { ok: true, data: updated };
  }

  deleteModel(
    modelId: string,
    ctx: ManagementActorContext,
  ): ManagementOutcome<{ model_id: string }> {
    const authErr = this.assertOwnerMutation(ctx, 'model:registry_write', 'model', modelId);
    if (authErr) return authErr;

    const existing = this.store.getManagedModel(modelId);
    if (!existing) {
      return {
        ok: false,
        code: 'MODEL_NOT_FOUND',
        error: `Model "${modelId}" was not found.`,
        http_status: 404,
      };
    }

    if (this.registry.getModel(modelId)) {
      const regRes = this.registry.removeModel(modelId, {
        actor: ctx.actor,
        declared_scopes: ['model:registry:write'],
        system_config: this.systemConfig,
        audit_logger: this.auditLogger,
        correlation_id: ctx.correlation_id,
      });
      if (!regRes.ok) {
        return {
          ok: false,
          code: regRes.code,
          error: regRes.error,
          http_status: 403,
        };
      }
    }

    this.store.deleteManagedModel(modelId);
    return { ok: true, data: { model_id: modelId } };
  }

  // ==================== D. WORKER & COMPUTE MANAGEMENT ====================

  listWorkers(limit = 50, offset = 0) {
    return this.store.listManagedWorkers({ limit, offset });
  }

  registerOrUpdateWorker(
    rawInput: Record<string, unknown>,
    ctx: ManagementActorContext,
    existingWorkerId?: string,
    approvalId?: string,
  ): ManagementOutcome<ManagedWorkerRecord> {
    const authErr = this.assertOwnerMutation(
      ctx,
      'runtime:manage',
      'system',
      existingWorkerId ??
        (typeof rawInput.worker_id === 'string' ? rawInput.worker_id : 'new_worker'),
    );
    if (authErr) return authErr;

    const forbiddenKey = hasForbiddenControlKeys(rawInput);
    if (forbiddenKey) {
      return {
        ok: false,
        code: 'RAW_WORKER_TOKEN_FORBIDDEN',
        error: `Raw secret field "${forbiddenKey}" cannot be submitted or stored. Reference only an environment variable name via auth_token_env_var.`,
        http_status: 400,
      };
    }

    const existing = existingWorkerId
      ? this.store.getManagedWorker(existingWorkerId)
      : null;
    if (existingWorkerId && !existing) {
      return {
        ok: false,
        code: 'WORKER_NOT_FOUND',
        error: `Worker "${existingWorkerId}" was not found.`,
        http_status: 404,
      };
    }

    const workerId = existingWorkerId
      ? existingWorkerId
      : typeof rawInput.worker_id === 'string' && rawInput.worker_id.trim().length > 0
        ? rawInput.worker_id.trim()
        : `worker_${crypto.randomUUID().slice(0, 8)}`;

    if (!VALID_ID_PATTERN.test(workerId)) {
      return {
        ok: false,
        code: 'INVALID_WORKER_ID',
        error: 'Worker ID must be 2-128 safe identifier characters.',
        http_status: 400,
      };
    }

    const name =
      typeof rawInput.name === 'string' && rawInput.name.trim().length > 0
        ? rawInput.name.trim().slice(0, 100)
        : existing?.name ?? workerId;

    const runtimeType = (
      rawInput.runtime_type ?? existing?.runtime_type ?? 'airllm'
    ) as LocalRuntimeType;
    if (!VALID_RUNTIME_TYPES.has(runtimeType)) {
      return {
        ok: false,
        code: 'INVALID_RUNTIME_TYPE',
        error: `Unsupported runtime_type "${String(runtimeType)}".`,
        http_status: 400,
      };
    }

    const baseUrl =
      typeof rawInput.base_url === 'string'
        ? rawInput.base_url.trim()
        : existing?.base_url ?? '';
    const urlCheck = validateControlledEndpointUrl(baseUrl);
    if (!urlCheck.valid) {
      return {
        ok: false,
        code: urlCheck.code ?? 'FORBIDDEN_WORKER_ENDPOINT',
        error: urlCheck.error ?? 'Invalid worker endpoint URL.',
        http_status: 400,
      };
    }

    const nodeId =
      typeof rawInput.node_id === 'string' && rawInput.node_id.trim().length > 0
        ? rawInput.node_id.trim().slice(0, 128)
        : existing?.node_id ?? 'local_host_airllm';

    const requiresAuth =
      typeof rawInput.requires_auth === 'boolean'
        ? rawInput.requires_auth
        : existing?.requires_auth ?? true;

    let authTokenEnvVar: string | null = existing?.auth_token_env_var ?? 'TEJAURA_AIRLLM_WORKER_TOKEN';
    if (rawInput.auth_token_env_var === null || rawInput.auth_token_env_var === '') {
      authTokenEnvVar = null;
    } else if (typeof rawInput.auth_token_env_var === 'string') {
      const trimmedVar = rawInput.auth_token_env_var.trim();
      if (!VALID_ENV_VAR_PATTERN.test(trimmedVar)) {
        return {
          ok: false,
          code: 'INVALID_ENV_VAR_REFERENCE',
          error:
            'auth_token_env_var must be an environment variable name (e.g. TEJAURA_AIRLLM_WORKER_TOKEN), never a literal secret.',
          http_status: 400,
        };
      }
      authTokenEnvVar = trimmedVar;
    }

    const enabled =
      typeof rawInput.enabled === 'boolean'
        ? rawInput.enabled
        : existing?.enabled ?? true;

    const endpoint: TrustedRuntimeEndpoint = {
      endpoint_id: workerId,
      runtime_type: runtimeType,
      base_url: urlCheck.normalized_url!,
      node_id: nodeId,
      enabled,
      requires_auth: requiresAuth,
      auth_token_env_var: authTokenEnvVar ?? undefined,
    };

    const approvalOutcome = this.obtainRuntimeApproval({
      resourceId: `runtime:${workerId}`,
      requiredScope: 'runtime:manage:approved',
      approvalId,
      ctx,
    });
    if (!approvalOutcome.ok) {
      return approvalOutcome;
    }

    const regRes = this.runtime.registerTrustedEndpoint(endpoint, {
      actor: this.managementExecutor(),
      environment: 'local' as const,
      declared_scopes: ['runtime:manage:approved'],
      approval: approvalOutcome.approval,
      now: this.clock(),
      system_config: this.systemConfig,
      audit_logger: this.auditLogger,
      correlation_id: ctx.correlation_id,
    });
    if (!regRes.ok) {
      return {
        ok: false,
        code: regRes.code ?? 'REGISTRATION_FAILED',
        error: regRes.error ?? 'Unknown error',
        http_status: 400,
      };
    }

    const nowIso = this.clock().toISOString();
    const record: ManagedWorkerRecord = {
      worker_id: workerId,
      name,
      runtime_type: runtimeType,
      node_id: nodeId,
      base_url: endpoint.base_url,
      requires_auth: requiresAuth,
      auth_token_env_var: authTokenEnvVar,
      enabled,
      health_status: existing?.health_status ?? 'unknown',
      current_model_id: existing?.current_model_id ?? null,
      active_jobs: existing?.active_jobs ?? 0,
      queue_length: existing?.queue_length ?? 0,
      latency_ms: existing?.latency_ms ?? null,
      discovered_models: existing?.discovered_models ?? [],
      last_checked_at: existing?.last_checked_at ?? null,
      last_error: existing?.last_error ?? null,
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
    };

    const saved = this.store.saveManagedWorker(record);
    return { ok: true, data: saved };
  }

  toggleWorker(
    workerId: string,
    enabled: boolean,
    ctx: ManagementActorContext,
    approvalId?: string,
  ): ManagementOutcome<ManagedWorkerRecord> {
    const authErr = this.assertOwnerMutation(ctx, 'runtime:manage', 'system', workerId);
    if (authErr) return authErr;

    const existing = this.store.getManagedWorker(workerId);
    if (!existing) {
      return {
        ok: false,
        code: 'WORKER_NOT_FOUND',
        error: `Worker "${workerId}" was not found.`,
        http_status: 404,
      };
    }

    const approvalOutcome = this.obtainRuntimeApproval({
      resourceId: `runtime:${workerId}`,
      requiredScope: 'runtime:manage:approved',
      approvalId,
      ctx,
    });
    if (!approvalOutcome.ok) {
      return approvalOutcome;
    }

    const toggleRes = this.runtime.setTrustedEndpointEnabled(workerId, enabled, {
      actor: this.managementExecutor(),
      environment: 'local' as const,
      declared_scopes: ['runtime:manage:approved'],
      approval: approvalOutcome.approval,
      now: this.clock(),
      system_config: this.systemConfig,
      audit_logger: this.auditLogger,
      correlation_id: ctx.correlation_id,
    });
    if (!toggleRes.ok) {
      return {
        ok: false,
        code: toggleRes.code,
        error: toggleRes.error ?? 'Unknown error',
        http_status: 400,
      };
    }

    const saved = this.store.saveManagedWorker({
      ...existing,
      enabled,
      updated_at: this.clock().toISOString(),
    });
    return { ok: true, data: saved };
  }

  deleteWorker(
    workerId: string,
    ctx: ManagementActorContext,
    approvalId?: string,
  ): ManagementOutcome<{ worker_id: string }> {
    const authErr = this.assertOwnerMutation(ctx, 'runtime:manage', 'system', workerId);
    if (authErr) return authErr;

    const existing = this.store.getManagedWorker(workerId);
    if (!existing) {
      return {
        ok: false,
        code: 'WORKER_NOT_FOUND',
        error: `Worker "${workerId}" was not found.`,
        http_status: 404,
      };
    }

    const approvalOutcome = this.obtainRuntimeApproval({
      resourceId: `runtime:${workerId}`,
      requiredScope: 'runtime:manage:approved',
      approvalId,
      ctx,
    });
    if (!approvalOutcome.ok) {
      return approvalOutcome;
    }

    const removeRes = this.runtime.removeTrustedEndpoint(workerId, {
      actor: this.managementExecutor(),
      environment: 'local' as const,
      declared_scopes: ['runtime:manage:approved'],
      approval: approvalOutcome.approval,
      now: this.clock(),
      system_config: this.systemConfig,
      audit_logger: this.auditLogger,
      correlation_id: ctx.correlation_id,
    });
    if (!removeRes.ok) {
      return {
        ok: false,
        code: removeRes.code ?? 'RUNTIME_REMOVE_FAILED',
        error: removeRes.error ?? 'Unknown error',
        http_status: 400,
      };
    }
    this.store.deleteManagedWorker(workerId);
    return { ok: true, data: { worker_id: workerId } };
  }

  async probeWorker(
    workerId: string,
    ctx: ManagementActorContext,
  ): Promise<ManagementOutcome<ManagedWorkerRecord>> {
    const authErr = this.assertOwnerMutation(ctx, 'runtime:probe', 'system', workerId);
    if (authErr) return authErr;

    const existing = this.store.getManagedWorker(workerId);
    if (!existing) {
      return {
        ok: false,
        code: 'WORKER_NOT_FOUND',
        error: `Worker "${workerId}" was not found.`,
        http_status: 404,
      };
    }

    const nowIso = this.clock().toISOString();
    const queuedTasks = this.store.listTasks({ status: 'queued', limit: 250 }).length;
    const queuedJobs = this.store.listAgentExecutionJobs({
      status: 'queued',
      limit: 250,
    }).length;
    const activeLeases = this.store.countActiveLeases(nowIso);

    if (!existing.enabled) {
      const updated = this.store.saveManagedWorker({
        ...existing,
        health_status: 'offline',
        active_jobs: activeLeases,
        queue_length: queuedTasks + queuedJobs,
        last_checked_at: nowIso,
        last_error: 'Worker endpoint is disabled by owner.',
        updated_at: nowIso,
      });
      return { ok: true, data: updated };
    }

    const startMs = Date.now();
    const health = await this.runtime.healthCheck(
      existing.runtime_type as LocalRuntimeType,
      existing.base_url,
    );
    const latencyMs = Math.max(1, Date.now() - startMs);

    let discoveredIds: string[] = [];
    let currentModelId: string | null = null;
    if (health.healthy) {
      try {
        const disc = await this.runtime.discoverModels(
          existing.runtime_type as LocalRuntimeType,
          existing.base_url,
          { timeoutMs: 3500 },
        );
        if (disc.ok) {
          discoveredIds = disc.models.map((m) => m.model_name);
          const loaded = disc.models.find((m) => (m as any).loaded);
          currentModelId = loaded?.model_name ?? discoveredIds[0] ?? null;
        }
      } catch {
        // Keep health status accurate
      }
    }

    const healthStatus = health.healthy ? 'online' : 'offline';

    const updated = this.store.saveManagedWorker({
      ...existing,
      health_status: healthStatus,
      current_model_id: currentModelId,
      active_jobs: activeLeases,
      queue_length: queuedTasks + queuedJobs,
      latency_ms: health.healthy ? latencyMs : null,
      discovered_models: discoveredIds,
      last_checked_at: nowIso,
      last_error: health.healthy ? null : sanitizeErrorString(health.error ?? 'Worker offline'),
      updated_at: nowIso,
    });

    this.auditManagementEvent({
      ctx,
      event_type: 'worker.health.probed',
      resource_type: 'system',
      resource_id: workerId,
      action: 'runtime:probe',
      outcome: healthStatus === 'online' ? 'success' : 'failure',
      metadata: {
        health_status: healthStatus,
        latency_ms: updated.latency_ms,
        queue_length: updated.queue_length,
      },
    });

    return { ok: true, data: updated };
  }

  // ==================== E. PROJECT & WEBSITE MANAGEMENT ====================

  listProjects(filter?: {
    environment?: string;
    limit?: number;
    offset?: number;
  }) {
    const env =
      filter?.environment && VALID_ENVIRONMENTS.has(filter.environment as ExecutionEnvironment)
        ? (filter.environment as ExecutionEnvironment)
        : undefined;
    return this.store.listManagedProjects({
      environment: env,
      limit: filter?.limit,
      offset: filter?.offset,
    });
  }

  createOrUpdateProject(
    rawInput: Record<string, unknown>,
    ctx: ManagementActorContext,
    existingProjectId?: string,
  ): ManagementOutcome<ManagedProjectRecord> {
    const authErr = this.assertOwnerMutation(
      ctx,
      existingProjectId ? 'project:update' : 'project:create',
      'system',
      existingProjectId ?? 'new_project',
    );
    if (authErr) return authErr;

    const existing = existingProjectId
      ? this.store.getManagedProject(existingProjectId)
      : null;
    if (existingProjectId && !existing) {
      return {
        ok: false,
        code: 'PROJECT_NOT_FOUND',
        error: `Project "${existingProjectId}" was not found.`,
        http_status: 404,
      };
    }

    const name =
      typeof rawInput.name === 'string'
        ? rawInput.name.trim().slice(0, 120)
        : existing?.name ?? '';
    const description =
      typeof rawInput.description === 'string'
        ? rawInput.description.trim().slice(0, 1000)
        : existing?.description ?? '';
    const rawSlug =
      typeof rawInput.slug === 'string'
        ? rawInput.slug.trim().toLowerCase()
        : existing?.slug ??
          name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');

    if (!name || name.length < 2 || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(rawSlug)) {
      return {
        ok: false,
        code: 'INVALID_PROJECT_NAME_OR_SLUG',
        error: 'Project name (min 2 chars) and valid URL-safe slug are required.',
        http_status: 400,
      };
    }

    const slugConflict = this.store.getManagedProjectBySlug(rawSlug);
    if (slugConflict && slugConflict.project_id !== existing?.project_id) {
      return {
        ok: false,
        code: 'PROJECT_SLUG_CONFLICT',
        error: `A project with slug "${rawSlug}" already exists.`,
        http_status: 409,
      };
    }

    const projectType = (
      rawInput.project_type ?? existing?.project_type ?? 'website'
    ) as ManagedProjectType;
    if (!VALID_PROJECT_TYPES.has(projectType)) {
      return {
        ok: false,
        code: 'INVALID_PROJECT_TYPE',
        error: 'project_type must be website, web_app, api_service, or automation.',
        http_status: 400,
      };
    }

    const environment = (
      rawInput.environment ?? existing?.environment ?? 'staging'
    ) as ExecutionEnvironment;
    if (!VALID_ENVIRONMENTS.has(environment)) {
      return {
        ok: false,
        code: 'INVALID_ENVIRONMENT',
        error: 'environment must be sandbox, local, staging, or production.',
        http_status: 400,
      };
    }

    const workspacePathRaw =
      typeof rawInput.workspace_path === 'string' && rawInput.workspace_path.trim()
        ? rawInput.workspace_path.trim()
        : existing?.workspace_path ?? `projects/${rawSlug}`;
    const safePath = validateSafeRelativePaths([workspacePathRaw]);
    if (!safePath.ok) {
      return {
        ok: false,
        code: 'INVALID_WORKSPACE_PATH',
        error: safePath.error,
        http_status: 400,
      };
    }

    let domainUrl: string | null = existing?.domain_url ?? null;
    if (rawInput.domain_url === null || rawInput.domain_url === '') {
      domainUrl = null;
    } else if (typeof rawInput.domain_url === 'string') {
      try {
        const parsed = new URL(rawInput.domain_url.trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return {
            ok: false,
            code: 'INVALID_DOMAIN_URL',
            error: 'Project domain_url must use http:// or https://.',
            http_status: 400,
          };
        }
        domainUrl = parsed.toString();
      } catch {
        return {
          ok: false,
          code: 'INVALID_DOMAIN_URL',
          error: 'Invalid project domain_url.',
          http_status: 400,
        };
      }
    }

    const assignedAgentIds = Array.isArray(rawInput.assigned_agent_ids)
      ? [
          ...new Set(
            rawInput.assigned_agent_ids
              .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
              .map((id) => id.trim()),
          ),
        ]
      : existing?.assigned_agent_ids ?? [];

    for (const agentId of assignedAgentIds) {
      const ag = this.store.getManagedAgent(agentId);
      if (!ag) {
        return {
          ok: false,
          code: 'ASSIGNED_AGENT_NOT_FOUND',
          error: `Assigned agent "${agentId}" does not exist.`,
          http_status: 400,
        };
      }
      if (ag.status === 'retired') {
        return {
          ok: false,
          code: 'ASSIGNED_AGENT_RETIRED',
          error: `Retired agent "${agentId}" cannot be assigned to a project.`,
          http_status: 400,
        };
      }
    }

    const nowIso = this.clock().toISOString();
    const projectId = existing?.project_id ?? `proj_${crypto.randomUUID().slice(0, 8)}`;
    const recentChanges = [
      {
        change_id: `chg_${crypto.randomUUID().slice(0, 8)}`,
        summary: existing
          ? 'Updated project configuration and agent assignments.'
          : 'Registered project in Owner Control Plane.',
        actor_id: ctx.actor.id,
        environment,
        created_at: nowIso,
      },
      ...(existing?.recent_changes ?? []),
    ].slice(0, 20);

    const record: ManagedProjectRecord = {
      project_id: projectId,
      name,
      slug: rawSlug,
      project_type: projectType,
      description: description || `${name} (${projectType})`,
      domain_url: domainUrl,
      workspace_path: safePath.paths[0]!,
      environment,
      deployment_status: existing?.deployment_status ?? 'draft',
      health_status: existing?.health_status ?? 'unknown',
      assigned_agent_ids: assignedAgentIds,
      recent_changes: recentChanges,
      recent_errors: existing?.recent_errors ?? [],
      pending_approval_id: existing?.pending_approval_id ?? null,
      last_deployed_at: existing?.last_deployed_at ?? null,
      created_by: existing?.created_by ?? ctx.actor.id,
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
    };

    if (
      !this.auditManagementEvent({
        ctx,
        event_type: existing ? 'project.updated' : 'project.created',
        resource_type: 'system',
        resource_id: projectId,
        action: existing ? 'project:update' : 'project:create',
        outcome: 'success',
        metadata: { slug: rawSlug, environment, assigned_agent_ids: assignedAgentIds },
      })
    ) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Project save aborted because audit logging failed.',
        http_status: 500,
      };
    }

    return { ok: true, data: this.store.saveManagedProject(record) };
  }

  deployProject(
    projectId: string,
    params: {
      target_environment?: ExecutionEnvironment;
      notes?: string;
      approval_id?: string;
    },
    ctx: ManagementActorContext,
  ): ManagementOutcome<{
    project: ManagedProjectRecord;
    requires_approval: boolean;
    approval?: ApprovalRecord;
  }> {
    const authErr = this.assertOwnerMutation(ctx, 'deploy:project', 'system', projectId);
    if (authErr) return authErr;

    const existing = this.store.getManagedProject(projectId);
    if (!existing) {
      return {
        ok: false,
        code: 'PROJECT_NOT_FOUND',
        error: `Project "${projectId}" was not found.`,
        http_status: 404,
      };
    }

    const targetEnv = params.target_environment ?? existing.environment;
    if (!VALID_ENVIRONMENTS.has(targetEnv)) {
      return {
        ok: false,
        code: 'INVALID_ENVIRONMENT',
        error: 'Target environment must be sandbox, local, staging, or production.',
        http_status: 400,
      };
    }

    const nowIso = this.clock().toISOString();
    const approvals = this.approvalsProvider();
    const action = targetEnv === 'production' ? 'deploy:production' : 'deploy:staging';
    const requiredScope = action;

    if (targetEnv === 'production' || targetEnv === 'staging') {
      if (!params.approval_id) {
        const existingPending = approvals
          .listApprovals()
          .find(
            (record) =>
              record.task_id === projectId &&
              record.action === action &&
              record.status === 'pending' &&
              record.scope.resources.includes(`project:${projectId}`) &&
              record.scope.permissions.includes(requiredScope),
          );

        let pendingApproval: ApprovalRecord;
        if (existingPending) {
          pendingApproval = existingPending;
        } else {
          const expiresAt = new Date(
            this.clock().getTime() + 24 * 60 * 60 * 1000,
          ).toISOString();
          const reqRes = approvals.requestApproval({
            task_id: projectId,
            action,
            requested_by: MANAGEMENT_EXECUTOR_ID,
            reason:
              params.notes?.trim() ||
              `${targetEnv} deployment requested for project "${existing.name}" (${existing.slug}).`,
            scope: {
              resources: [`project:${projectId}`],
              permissions: [requiredScope],
              single_use: true,
              expires_at: expiresAt,
            },
            environment: targetEnv,
            correlation_id: ctx.correlation_id,
          });
          if (!reqRes.ok) {
            return {
              ok: false,
              code: reqRes.code,
              error: reqRes.error,
              http_status: 400,
            };
          }
          pendingApproval = reqRes.record;
        }

        const pendingProject = this.store.saveManagedProject({
          ...existing,
          environment: targetEnv,
          deployment_status: 'pending_approval',
          pending_approval_id: pendingApproval.id,
          recent_changes: [
            {
              change_id: `chg_${crypto.randomUUID().slice(0, 8)}`,
              summary: `${targetEnv} deployment queued for owner approval (${pendingApproval.id}).`,
              actor_id: ctx.actor.id,
              environment: targetEnv,
              created_at: nowIso,
            },
            ...existing.recent_changes,
          ].slice(0, 20),
          updated_at: nowIso,
        });

        return {
          ok: true,
          data: {
            project: pendingProject,
            requires_approval: true,
            approval: pendingApproval,
          },
        };
      }

      const consumed = approvals.verifyAndConsumeApproval({
        approval_id: params.approval_id,
        task_id: projectId,
        action,
        actor_id: MANAGEMENT_EXECUTOR_ID,
        resource_id: `project:${projectId}`,
        required_scope: requiredScope,
        environment: targetEnv,
        correlation_id: ctx.correlation_id,
      });
      if (!consumed.ok) {
        return {
          ok: false,
          code: consumed.code,
          error: consumed.error,
          http_status: 403,
        };
      }

      const contractApproval = toContractApproval(consumed.record);
      const policy = evaluatePolicyWithAudit({
        actor: targetEnv === 'production' ? ctx.actor : this.managementExecutor(),
        action,
        resource: { id: `project:${projectId}`, type: 'system' },
        environment: targetEnv,
        declared_scopes: [requiredScope],
        approval: targetEnv === 'production' ? null : contractApproval,
        owner_confirmed_l4: targetEnv === 'production' ? true : undefined,
        now: this.clock(),
        system_config: this.systemConfig,
        audit_logger: this.auditLogger,
        correlation_id: ctx.correlation_id,
      });
      if (!policy.allowed) {
        return {
          ok: false,
          code: policy.reason_code,
          error: policy.reason,
          http_status: 403,
        };
      }
    }

    const deployed = this.store.saveManagedProject({
      ...existing,
      environment: targetEnv,
      deployment_status: 'deployed',
      health_status: 'healthy',
      pending_approval_id: null,
      last_deployed_at: nowIso,
      recent_changes: [
        {
          change_id: `chg_${crypto.randomUUID().slice(0, 8)}`,
          summary:
            params.notes?.trim() ||
            `Deployed to ${targetEnv} environment by owner.`,
          actor_id: ctx.actor.id,
          environment: targetEnv,
          created_at: nowIso,
        },
        ...existing.recent_changes,
      ].slice(0, 20),
      updated_at: nowIso,
    });

    this.auditManagementEvent({
      ctx,
      event_type: 'project.deployed',
      resource_type: 'system',
      resource_id: projectId,
      action,
      outcome: 'success',
      metadata: {
        environment: targetEnv,
        approval_id: params.approval_id ?? null,
      },
    });

    return {
      ok: true,
      data: {
        project: deployed,
        requires_approval: false,
      },
    };
  }

  /**
   * Called from Approval Inbox decision endpoint when the approval targets a project (`proj_*`).
   */
  decideProjectApproval(params: {
    approval_id: string;
    decision: 'approved' | 'rejected';
    reviewer: TrustedReviewerContext;
    reason: string;
    correlation_id: string;
  }): ManagementOutcome<{
    approval: ApprovalRecord;
    project: ManagedProjectRecord | null;
  }> {
    const approvals = this.approvalsProvider();
    const res = approvals.decideApproval({
      approval_id: params.approval_id,
      decision: params.decision,
      reviewer: params.reviewer,
      reason: params.reason,
      correlation_id: params.correlation_id,
    });
    if (!res.ok) {
      return {
        ok: false,
        code: res.code,
        error: res.error,
        http_status: res.code === 'APPROVAL_NOT_FOUND' ? 404 : 403,
      };
    }

    const project = this.store.getManagedProject(res.record.task_id);
    if (!project) {
      return { ok: true, data: { approval: res.record, project: null } };
    }

    const nowIso = this.clock().toISOString();
    let updatedProject: ManagedProjectRecord;

    if (params.decision === 'approved') {
      const requiredScope = res.record.scope.permissions[0];
      const environment = res.record.environment as ExecutionEnvironment;
      if (!requiredScope || !environment) {
        return {
          ok: false,
          code: 'INVALID_APPROVAL_SCOPE',
          error: 'Deployment approval is missing its bound scope or environment.',
          http_status: 400,
        };
      }

      // Execution is performed by the control-plane requester, never by the
      // reviewing owner, so approval reviewer/executor separation is preserved.
      const consumed = approvals.verifyAndConsumeApproval({
        approval_id: res.record.id,
        task_id: project.project_id,
        action: res.record.action,
        actor_id: res.record.requested_by,
        resource_id: `project:${project.project_id}`,
        required_scope: requiredScope,
        environment,
        correlation_id: params.correlation_id,
      });
      if (!consumed.ok) {
        return {
          ok: false,
          code: consumed.code,
          error: consumed.error,
          http_status: 403,
        };
      }
      updatedProject = this.store.saveManagedProject({
        ...project,
        environment,
        deployment_status: 'deployed',
        health_status: 'healthy',
        pending_approval_id: null,
        last_deployed_at: nowIso,
        recent_changes: [
          {
            change_id: `chg_${crypto.randomUUID().slice(0, 8)}`,
            summary: `${environment} deployment approved & released (${res.record.id}): ${params.reason}`,
            actor_id: params.reviewer.actor_id,
            environment,
            created_at: nowIso,
          },
          ...project.recent_changes,
        ].slice(0, 20),
        updated_at: nowIso,
      });
    } else {
      updatedProject = this.store.saveManagedProject({
        ...project,
        deployment_status: 'draft' as ManagedProjectDeploymentStatus,
        pending_approval_id: null,
        recent_errors: [
          {
            error_id: `perr_${crypto.randomUUID().slice(0, 8)}`,
            code: 'DEPLOYMENT_REJECTED_BY_OWNER',
            message: `Production deployment rejected: ${params.reason}`,
            created_at: nowIso,
          },
          ...project.recent_errors,
        ].slice(0, 20),
        updated_at: nowIso,
      });
    }

    return { ok: true, data: { approval: res.record, project: updatedProject } };
  }

  deleteProject(
    projectId: string,
    ctx: ManagementActorContext,
  ): ManagementOutcome<{ project_id: string }> {
    const authErr = this.assertOwnerMutation(ctx, 'project:delete', 'system', projectId);
    if (authErr) return authErr;

    const existing = this.store.getManagedProject(projectId);
    if (!existing) {
      return {
        ok: false,
        code: 'PROJECT_NOT_FOUND',
        error: `Project "${projectId}" was not found.`,
        http_status: 404,
      };
    }

    this.auditManagementEvent({
      ctx,
      event_type: 'project.deleted',
      resource_type: 'system',
      resource_id: projectId,
      action: 'project:delete',
      outcome: 'success',
      metadata: { slug: existing.slug },
    });

    this.store.deleteManagedProject(projectId);
    return { ok: true, data: { project_id: projectId } };
  }

  // ==================== F. SYSTEM ADMINISTRATION ====================

  getRuntimeSystemConfig(): ManagementSystemConfig {
    const getVal = <T>(key: string, fallback: T): T => {
      const entry = this.store.getSystemConfigEntry(key);
      return entry ? (entry.config_value as T) : fallback;
    };

    const models = this.store.listManagedModels({ limit: 250 }).items;
    const defaultModel = models.find((m) => m.is_default)?.model_id ?? null;
    const backupModel = models.find((m) => m.is_backup)?.model_id ?? null;

    return {
      maintenance_mode: getVal<boolean>('maintenance_mode', false),
      max_queue_depth: getVal<number>('max_queue_depth', 20),
      auto_recover_leases: getVal<boolean>('auto_recover_leases', true),
      preferred_model_source: getVal<ManagedModelSource>(
        'preferred_model_source',
        'modelscope',
      ),
      default_model_id: getVal<string | null>('default_model_id', defaultModel),
      backup_model_id: getVal<string | null>('backup_model_id', backupModel),
    };
  }

  updateRuntimeSystemConfig(
    rawInput: Record<string, unknown>,
    ctx: ManagementActorContext,
  ): ManagementOutcome<ManagementSystemConfig> {
    const authErr = this.assertOwnerMutation(ctx, 'system:config_update', 'configuration', 'system_config_kv');
    if (authErr) return authErr;

    const forbidden = hasForbiddenControlKeys(rawInput);
    if (forbidden) {
      return {
        ok: false,
        code: 'FORBIDDEN_CONFIG_KEY',
        error: `Secret-like field "${forbidden}" cannot be stored in system configuration.`,
        http_status: 400,
      };
    }

    const nowIso = this.clock().toISOString();
    const updatedKeys: string[] = [];

    if (typeof rawInput.maintenance_mode === 'boolean') {
      this.store.setSystemConfigEntry({
        config_key: 'maintenance_mode',
        config_value: rawInput.maintenance_mode,
        updated_at: nowIso,
        updated_by: ctx.actor.id,
      });
      updatedKeys.push('maintenance_mode');
    }

    if (typeof rawInput.max_queue_depth === 'number' && Number.isFinite(rawInput.max_queue_depth)) {
      const bounded = Math.min(500, Math.max(5, Math.round(rawInput.max_queue_depth)));
      this.store.setSystemConfigEntry({
        config_key: 'max_queue_depth',
        config_value: bounded,
        updated_at: nowIso,
        updated_by: ctx.actor.id,
      });
      updatedKeys.push('max_queue_depth');
    }

    if (typeof rawInput.auto_recover_leases === 'boolean') {
      this.store.setSystemConfigEntry({
        config_key: 'auto_recover_leases',
        config_value: rawInput.auto_recover_leases,
        updated_at: nowIso,
        updated_by: ctx.actor.id,
      });
      updatedKeys.push('auto_recover_leases');
    }

    if (
      typeof rawInput.preferred_model_source === 'string' &&
      VALID_MODEL_SOURCES.has(rawInput.preferred_model_source as ManagedModelSource)
    ) {
      this.store.setSystemConfigEntry({
        config_key: 'preferred_model_source',
        config_value: rawInput.preferred_model_source,
        updated_at: nowIso,
        updated_by: ctx.actor.id,
      });
      updatedKeys.push('preferred_model_source');
    }

    this.auditManagementEvent({
      ctx,
      event_type: 'system.config.updated',
      resource_type: 'configuration',
      resource_id: 'system_config_kv',
      action: 'system:config_update',
      outcome: 'success',
      metadata: { updated_keys: updatedKeys },
    });

    return { ok: true, data: this.getRuntimeSystemConfig() };
  }

  getSystemAdminOverview() {
    const dbStats = this.store.getDatabaseStats();
    const workers = this.store.listManagedWorkers({ limit: 100 }).items;
    const queuedTasks = this.store.listTasks({ status: 'queued', limit: 250 }).length;
    const failedTasks = this.store.listTasks({ status: 'failed', limit: 50 }).length;
    const queuedJobs = this.store.listAgentExecutionJobs({
      status: 'queued',
      limit: 250,
    }).length;
    const failedJobs = this.store.listAgentExecutionJobs({
      status: 'failed',
      limit: 50,
    }).length;
    const stateDirBytes = computeDirectoryBytes(this.stateDir);
    const backupsBytes = computeDirectoryBytes(this.backupsDir);

    return {
      generated_at: this.clock().toISOString(),
      database: dbStats,
      migrations: this.store.getAppliedMigrations(),
      storage: {
        state_dir_bytes: stateDirBytes,
        backups_dir_bytes: backupsBytes,
        db_estimated_bytes: dbStats.estimated_bytes,
      },
      queue_health: {
        queued_tasks: queuedTasks,
        queued_agent_jobs: queuedJobs,
        active_leases: this.store.countActiveLeases(this.clock().toISOString()),
        recent_failed_tasks: failedTasks,
        recent_failed_jobs: failedJobs,
      },
      workers_summary: {
        total: workers.length,
        enabled: workers.filter((w) => w.enabled).length,
        online: workers.filter((w) => w.health_status === 'online').length,
        offline: workers.filter((w) => w.health_status === 'offline').length,
      },
      config: this.getRuntimeSystemConfig(),
      backups: this.store.listSystemBackups(25),
    };
  }

  querySystemLogs(filter?: {
    source?: 'all' | 'audit' | 'task_event' | 'agent_execution';
    severity?: 'all' | 'info' | 'warn' | 'error';
    limit?: number;
    offset?: number;
  }): { items: UnifiedLogEntry[]; total: number } {
    const entries: UnifiedLogEntry[] = [];
    const sourceFilter = filter?.source ?? 'all';

    if (sourceFilter === 'all' || sourceFilter === 'audit') {
      let rawAudit: Array<Record<string, unknown>> = [];
      if (this.auditStorage instanceof InMemoryAuditStorage) {
        rawAudit = this.auditStorage.getEvents() as unknown as Array<Record<string, unknown>>;
      } else if (this.auditStorage instanceof JsonlAuditStorage) {
        const filePath = this.auditStorage.getFilePath();
        if (filePath && fs.existsSync(filePath)) {
          const lines = fs
            .readFileSync(filePath, 'utf8')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-250);
          rawAudit = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        }
      }
      for (const ev of rawAudit) {
        const outcome = String(ev.outcome ?? 'info');
        const severity: UnifiedLogEntry['severity'] =
          outcome === 'failure' || outcome === 'denied'
            ? 'error'
            : outcome === 'pending'
              ? 'warn'
              : 'info';
        entries.push({
          log_id: String(ev.id ?? crypto.randomUUID()),
          source: 'audit',
          severity,
          timestamp: String(ev.timestamp ?? ''),
          actor_id: String(ev.actor_id ?? 'system'),
          action: String(ev.action ?? ev.event_type ?? 'audit'),
          outcome,
          resource_id: String(ev.resource_id ?? 'system'),
          message: sanitizeErrorString(`${ev.event_type ?? 'event'} (${outcome})`),
        });
      }
    }

    if (sourceFilter === 'all' || sourceFilter === 'task_event') {
      for (const evt of this.store.listRecentTaskEvents(150)) {
        const severity: UnifiedLogEntry['severity'] =
          evt.to_status === 'failed' || evt.event_type.includes('blocked')
            ? 'error'
            : evt.to_status === 'waiting_for_approval'
              ? 'warn'
              : 'info';
        entries.push({
          log_id: evt.event_id,
          source: 'task_event',
          severity,
          timestamp: evt.created_at,
          actor_id: evt.actor_id,
          action: evt.event_type,
          outcome: evt.to_status ?? 'recorded',
          resource_id: evt.task_id,
          message: sanitizeErrorString(evt.message),
        });
      }
    }

    if (sourceFilter === 'all' || sourceFilter === 'agent_execution') {
      for (const log of this.store.listAgentExecutionLogs({ limit: 150 })) {
        const severity: UnifiedLogEntry['severity'] =
          log.outcome === 'failed' || log.outcome === 'denied'
            ? 'error'
            : log.outcome === 'approval_required'
              ? 'warn'
              : 'info';
        entries.push({
          log_id: log.log_id,
          source: 'agent_execution',
          severity,
          timestamp: log.created_at,
          actor_id: log.agent_id,
          action: log.requested_action,
          outcome: log.outcome,
          resource_id: log.job_id ?? log.task_id,
          message: sanitizeErrorString(log.summary),
        });
      }
    }

    const sevFilter = filter?.severity ?? 'all';
    const filtered =
      sevFilter === 'all'
        ? entries
        : entries.filter((e) => e.severity === sevFilter);

    filtered.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    const offset = Math.max(0, filter?.offset ?? 0);
    const limit = Math.min(100, Math.max(1, filter?.limit ?? 40));
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
    };
  }

  createSystemBackup(ctx: ManagementActorContext): ManagementOutcome<SystemBackupRecord> {
    const authErr = this.assertOwnerMutation(ctx, 'system:backup_create', 'system', 'backup');
    if (authErr) return authErr;

    fs.mkdirSync(this.backupsDir, { recursive: true, mode: 0o700 });
    const nowIso = this.clock().toISOString();
    const backupId = `bkp_${crypto.randomUUID().slice(0, 12)}`;
    const safeFileName = `${backupId}.json`;
    const targetPath = path.resolve(this.backupsDir, safeFileName);
    if (!targetPath.startsWith(this.backupsDir + path.sep)) {
      return {
        ok: false,
        code: 'INVALID_BACKUP_PATH',
        error: 'Backup file path escapes confined backup directory.',
        http_status: 400,
      };
    }

    const snapshot = {
      backup_id: backupId,
      created_at: nowIso,
      created_by: ctx.actor.id,
      management: this.store.exportManagementSnapshot(),
    };
    const serialized = JSON.stringify(snapshot, null, 2);
    const sha256 = crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');

    fs.writeFileSync(targetPath, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(targetPath, 0o600);
    const sizeBytes = Buffer.byteLength(serialized, 'utf8');

    const mgmt = snapshot.management as Record<string, unknown[]>;
    const record: SystemBackupRecord = {
      backup_id: backupId,
      filename: safeFileName,
      size_bytes: sizeBytes,
      sha256,
      summary: {
        agents: Array.isArray(mgmt.agents) ? mgmt.agents.length : 0,
        models: Array.isArray(mgmt.models) ? mgmt.models.length : 0,
        workers: Array.isArray(mgmt.workers) ? mgmt.workers.length : 0,
        projects: Array.isArray(mgmt.projects) ? mgmt.projects.length : 0,
      },
      created_by: ctx.actor.id,
      created_at: nowIso,
      restored_at: null,
    };

    const saved = this.store.saveSystemBackup(record);
    this.auditManagementEvent({
      ctx,
      event_type: 'system.backup.created',
      resource_type: 'system',
      resource_id: backupId,
      action: 'system:backup_create',
      outcome: 'success',
      metadata: { filename: safeFileName, sha256, size_bytes: sizeBytes },
    });

    return { ok: true, data: saved };
  }

  restoreSystemBackup(
    backupId: string,
    ctx: ManagementActorContext,
  ): ManagementOutcome<SystemBackupRecord> {
    const authErr = this.assertOwnerMutation(ctx, 'system:backup_restore', 'system', backupId);
    if (authErr) return authErr;

    const record = this.store.getSystemBackup(backupId);
    if (!record) {
      return {
        ok: false,
        code: 'BACKUP_NOT_FOUND',
        error: `Backup "${backupId}" was not found.`,
        http_status: 404,
      };
    }

    const safeFileName = path.basename(record.filename);
    const targetPath = path.resolve(this.backupsDir, safeFileName);
    if (!targetPath.startsWith(this.backupsDir + path.sep) || !fs.existsSync(targetPath)) {
      return {
        ok: false,
        code: 'BACKUP_FILE_MISSING',
        error: `Backup artifact "${safeFileName}" is missing from confined backup directory.`,
        http_status: 404,
      };
    }

    const raw = fs.readFileSync(targetPath, 'utf8');
    const actualHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
    if (actualHash !== record.sha256) {
      return {
        ok: false,
        code: 'BACKUP_CHECKSUM_MISMATCH',
        error: 'Backup integrity check failed: SHA-256 checksum does not match.',
        http_status: 409,
      };
    }

    const parsed = JSON.parse(raw) as { management?: Record<string, unknown> };
    if (!parsed.management || typeof parsed.management !== 'object') {
      return {
        ok: false,
        code: 'BACKUP_CORRUPTED',
        error: 'Backup file does not contain a valid management snapshot.',
        http_status: 400,
      };
    }

    this.store.restoreManagementSnapshot(parsed.management);
    this.syncFromPersistenceOnStartup();

    const nowIso = this.clock().toISOString();
    this.store.markSystemBackupRestored(backupId, nowIso);

    this.auditManagementEvent({
      ctx,
      event_type: 'system.backup.restored',
      resource_type: 'system',
      resource_id: backupId,
      action: 'system:backup_restore',
      outcome: 'success',
      metadata: { sha256: actualHash },
    });

    return { ok: true, data: this.store.getSystemBackup(backupId)! };
  }
}
