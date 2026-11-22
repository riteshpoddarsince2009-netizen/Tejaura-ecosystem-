import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import type {
  AutonomyLevel,
  ExecutionEnvironment,
  TaskStatus,
} from '../../contracts/types/index.ts';
import {
  EncryptedFileIdentityStoreBackend,
  TejauraAuthService,
  type AuthRequestContext,
  type AuthenticatedSessionContext,
  type IdentityStoreBackend,
} from '../../core/auth/index.ts';
import {
  AuditLogger,
  InMemoryAuditStorage,
  JsonlAuditStorage,
  type AuditStorage,
} from '../../core/audit/index.ts';
import systemConfigDefault from '../../core/configuration/system.json' with { type: 'json' };
import { POLICY_ACTION_CATALOG } from '../../core/policy/index.ts';
import {
  ROLE_PERMISSIONS,
  authorizeRbac,
  type RbacPrincipal,
} from '../../core/rbac/index.ts';
import {
  EnvSecretProvider,
  FileEncryptedVaultBackend,
  SecretsManager,
  type EncryptedVaultBackend,
} from '../../core/secrets/index.ts';
import securityConfigDefault from '../../core/security/security-config.example.json' with { type: 'json' };
import {
  validateSecurityConfig,
  type SecurityConfig,
} from '../../core/security/index.ts';
import {
  HardwareManager,
  type ComputeNode,
} from '../../intelligence/hardware/index.ts';
import { ModelLifecycleManager } from '../../intelligence/lifecycle/index.ts';
import localModelsDefault from '../../intelligence/model-registry/local-models.json' with { type: 'json' };
import {
  LocalModelRegistry,
  type LocalModelRegistryDocument,
} from '../../intelligence/model-registry/local-model-registry.ts';
import { ModelRouter } from '../../intelligence/router/index.ts';
import {
  PRIMARY_LOCAL_RUNTIME,
  RuntimeManager,
  type TrustedRuntimeEndpoint,
} from '../../intelligence/runtime/index.ts';
import {
  SqliteOrchestrationStore,
  type OrchestrationStore,
  type ScheduleTaskTemplate,
} from '../db/index.ts';
import {
  AgentExecutionEngine,
  MockSandboxAdapter,
} from '../../execution/index.ts';
import { ManagementService } from '../management/index.ts';
import {
  TaskOrchestrator,
  type ExternalTaskActionHandler,
} from '../orchestrator/index.ts';

export interface ControlPlaneServerOptions {
  stateDir?: string;
  dbPath?: string;
  masterKeyMaterial?: Buffer | string;
  securityConfig?: SecurityConfig;
  systemConfig?: unknown;
  environment?: AuthRequestContext['environment'];
  store?: OrchestrationStore;
  identityStore?: IdentityStoreBackend;
  vaultBackend?: EncryptedVaultBackend;
  auditStorage?: AuditStorage;
  auditLogPath?: string;
  registry?: LocalModelRegistry;
  hardware?: HardwareManager;
  runtime?: RuntimeManager;
  trustedEndpoints?: TrustedRuntimeEndpoint[];
  maxConcurrentRunning?: number;
  leaseDurationMs?: number;
  externalHandlers?: Record<string, ExternalTaskActionHandler>;
  rateLimitMaxRequestsPerMinute?: number;
  clock?: () => Date;
}

export interface ControlPlaneAppBundle {
  app: Express;
  store: OrchestrationStore;
  auth: TejauraAuthService;
  secretsManager: SecretsManager;
  auditLogger: AuditLogger;
  registry: LocalModelRegistry;
  hardware: HardwareManager;
  runtime: RuntimeManager;
  lifecycle: ModelLifecycleManager;
  router: ModelRouter;
  orchestrator: TaskOrchestrator;
  executionEngine: AgentExecutionEngine;
  management: ManagementService;
  close: () => void;
}

interface AuthedRequest extends Request {
  tejauraSession?: AuthenticatedSessionContext;
  tejauraCorrelationId?: string;
}

const DEFAULT_STATE_DIR = '.tejaura-state';
const VALID_TASK_STATUSES = new Set<TaskStatus>([
  'queued',
  'running',
  'waiting_for_approval',
  'succeeded',
  'failed',
  'cancelled',
]);
const VALID_ENVIRONMENTS = new Set<ExecutionEnvironment>([
  'sandbox',
  'local',
  'staging',
  'production',
]);
const VALID_AUTONOMY = new Set<AutonomyLevel>(['L0', 'L1', 'L2', 'L3', 'L4']);

const DEFAULT_WORKER_SERVICE_PRINCIPAL: RbacPrincipal = {
  actor_id: 'airllm_worker_client',
  actor_type: 'system',
  role: 'worker_service',
  authenticated: true,
  auth_source: 'tejaura-worker-runtime',
};

function resolveMasterKeyMaterial(
  explicitKey: Buffer | string | undefined,
  stateDir: string,
  envMode: AuthRequestContext['environment'],
): Buffer | string {
  if (explicitKey) {
    return explicitKey;
  }

  const fromEnv = process.env.TEJAURA_SECRETS_MASTER_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim().length >= 16) {
    return fromEnv.trim();
  }

  if (envMode === 'production') {
    throw new Error(
      'TEJAURA_SECRETS_MASTER_KEY environment variable (at least 16 chars) is required in production.',
    );
  }

  const resolvedState = path.resolve(stateDir);
  fs.mkdirSync(resolvedState, { recursive: true, mode: 0o700 });
  const keyFile = path.join(resolvedState, 'dev-master.key');
  if (fs.existsSync(keyFile)) {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();
    if (existing.length >= 32) {
      return existing;
    }
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyFile, `${generated}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.chmodSync(keyFile, 0o600);
  return generated;
}

function buildDefaultComputeNodes(): ComputeNode[] {
  return [
    {
      node_id: 'local_host_airllm',
      name: 'Owner Local / Remote AirLLM Compute Node',
      location: 'local',
      online: true,
      has_gpu: false,
      total_ram_mb: 16384,
      available_ram_mb: 12288,
      total_vram_mb: 0,
      available_vram_mb: 0,
      total_storage_mb: 102400,
      available_storage_mb: 65536,
      supported_runtimes: ['airllm', 'ollama', 'llama_cpp'],
      installed_model_ids: [],
      last_seen_at: new Date().toISOString(),
    },
  ];
}

function getDefaultTrustedEndpoints(): TrustedRuntimeEndpoint[] {
  const endpoints: TrustedRuntimeEndpoint[] = [];
  const airllmUrl = process.env.TEJAURA_AIRLLM_WORKER_URL;
  if (typeof airllmUrl === 'string' && airllmUrl.trim().length > 0) {
    endpoints.push({
      endpoint_id: 'airllm_primary_worker',
      runtime_type: 'airllm',
      base_url: airllmUrl.trim(),
      node_id: 'local_host_airllm',
      enabled: true,
      requires_auth: true,
      auth_token_env_var: 'TEJAURA_AIRLLM_WORKER_TOKEN',
    });
  }
  return endpoints;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeString(value: unknown, minLen: number, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < minLen || trimmed.length > maxLen) return null;
  return trimmed;
}

function normalizeHostPort(hostHeader: string | undefined): string {
  return (hostHeader ?? '').trim().toLowerCase();
}

export function createControlPlaneApp(
  options: ControlPlaneServerOptions = {},
): ControlPlaneAppBundle {
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const envMode: AuthRequestContext['environment'] =
    options.environment ??
    (process.env.NODE_ENV === 'production' ? 'production' : 'development');

  const configCheck = validateSecurityConfig(
    options.securityConfig ?? securityConfigDefault,
  );
  if (!configCheck.valid) {
    throw new Error(
      `Invalid Stage 2B SecurityConfig: ${configCheck.errors.map((e) => e.message).join('; ')}`,
    );
  }
  const securityConfig = configCheck.data;
  const systemConfig = options.systemConfig ?? systemConfigDefault;
  const clock = options.clock ?? (() => new Date());

  const masterKeyMaterial = resolveMasterKeyMaterial(
    options.masterKeyMaterial,
    stateDir,
    envMode,
  );

  const auditFilePath =
    options.auditLogPath ?? path.resolve(stateDir, 'audit.jsonl');
  const auditStorage: AuditStorage =
    options.auditStorage ??
    new JsonlAuditStorage({
      auditDir: path.dirname(auditFilePath),
      fileName: path.basename(auditFilePath),
    });
  const auditLogger = new AuditLogger({
    storage: auditStorage,
    clock,
  });

  const secretsManager = new SecretsManager({
    masterKeyMaterial,
    envProvider: new EnvSecretProvider(),
    vaultBackend:
      options.vaultBackend ??
      new FileEncryptedVaultBackend(stateDir, 'secrets.vault.json'),
    auditLogger,
    clock,
  });

  const identityStore: IdentityStoreBackend =
    options.identityStore ??
    new EncryptedFileIdentityStoreBackend({
      stateDir,
      masterKeyMaterial,
      fileName: 'identity.enc.json',
    });

  const auth = new TejauraAuthService({
    securityConfig,
    masterKeyMaterial,
    store: identityStore,
    secretsManager,
    auditLogger,
    clock,
  });

  const store: OrchestrationStore =
    options.store ??
    new SqliteOrchestrationStore({
      dbPath: options.dbPath ?? path.resolve(stateDir, 'tejaura-control-plane.db'),
    });

  const registry =
    options.registry ??
    new LocalModelRegistry(localModelsDefault as LocalModelRegistryDocument);
  const hardware =
    options.hardware ?? new HardwareManager(buildDefaultComputeNodes());
  const runtime =
    options.runtime ??
    new RuntimeManager({
      trustedEndpoints:
        options.trustedEndpoints ?? getDefaultTrustedEndpoints(),
      authTokenResolver: (endpoint) => {
        if (endpoint.runtime_type !== 'airllm') {
          return undefined;
        }
        const tokRes = secretsManager.getAirLlmWorkerToken({
          principal: DEFAULT_WORKER_SERVICE_PRINCIPAL,
          correlation_id: `corr_worker_tok_${Date.now()}`,
        });
        return tokRes.ok ? tokRes.value : undefined;
      },
    });
  const lifecycle = new ModelLifecycleManager({
    registry,
    hardware,
    runtime,
  });
  const router = new ModelRouter({
    registry,
    hardware,
    lifecycle,
    runtime,
  });

  const existingIdentity = identityStore.load();
  const orchestrator = new TaskOrchestrator({
    store,
    designatedOwnerId: existingIdentity.owner?.owner_id ?? 'owner_primary',
    systemConfig,
    auditLogger,
    registry,
    hardware,
    lifecycle,
    runtime,
    router,
    maxConcurrentRunning: options.maxConcurrentRunning ?? 2,
    leaseDurationMs: options.leaseDurationMs ?? 60_000,
    externalHandlers: options.externalHandlers,
    clock,
  });

  const executionEngine = new AgentExecutionEngine({
    store,
    approvals: orchestrator.getApprovalService(),
    auditLogger,
    systemConfig,
    policyConfig: {
      workspaceRoot: process.cwd(),
      allowedRelativePaths: ['sandbox'],
      defaultNetworkMode: 'none',
      defaultBrowserMode: 'disabled',
    },
    adapters: [new MockSandboxAdapter({ router, systemConfig })],
    defaultSandboxProvider: 'mock_sandbox_v1',
    clock,
  });
  executionEngine.recoverOnStartup();

  const management = new ManagementService({
    store,
    registry,
    hardware,
    runtime,
    auditLogger,
    auditStorage,
    approvalsProvider: () => orchestrator.getApprovalService(),
    systemConfig,
    stateDir,
    clock,
  });
  management.syncFromPersistenceOnStartup();

  const app = express();
  app.disable('x-powered-by');
  if (securityConfig.transport.trustProxyProtoHeader) {
    app.set('trust proxy', 1);
  }

  // Sliding-window API rate limiter (in-memory per IP, bounded memory)
  const maxReqsPerMin = Math.max(20, options.rateLimitMaxRequestsPerMinute ?? 180);
  const rateWindows = new Map<string, { windowStartMs: number; count: number }>();

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) {
      // Strictly protect API endpoints; leave root HTML iframe-compatible for AI Studio preview.
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  });

  app.use('/api', (req: AuthedRequest, res: Response, next: NextFunction) => {
    req.tejauraCorrelationId = `corr_http_${crypto.randomUUID().slice(0, 12)}`;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const nowMs = clock().getTime();
    const current = rateWindows.get(ip);
    if (!current || nowMs - current.windowStartMs >= 60_000) {
      if (rateWindows.size > 2000) {
        rateWindows.clear();
      }
      rateWindows.set(ip, { windowStartMs: nowMs, count: 1 });
    } else {
      current.count += 1;
      if (current.count > maxReqsPerMin) {
        res.setHeader('Retry-After', '60');
        res.status(429).json({
          ok: false,
          code: 'RATE_LIMITED',
          error: 'API rate limit exceeded. Please wait briefly before retrying.',
        });
        return;
      }
    }
    next();
  });

  app.use(
    '/api',
    express.json({ limit: '64kb', strict: true }),
  );

  // Convert body parser syntax/size failures into deterministic sanitized JSON errors.
  app.use(
    (
      err: unknown,
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      if (!req.path.startsWith('/api')) {
        next(err);
        return;
      }
      const typed = err as { type?: string; status?: number };
      if (typed?.type === 'entity.too.large' || typed?.status === 413) {
        res.status(413).json({
          ok: false,
          code: 'PAYLOAD_TOO_LARGE',
          error: 'Request JSON payload exceeds the 64KB control plane limit.',
        });
        return;
      }
      if (err instanceof SyntaxError || typed?.status === 400) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_JSON',
          error: 'Malformed JSON request body.',
        });
        return;
      }
      res.status(500).json({
        ok: false,
        code: 'INTERNAL_CONTROL_PLANE_ERROR',
        error: 'Internal control plane error.',
      });
    },
  );

  // CSRF protection on all state-changing API routes.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      next();
      return;
    }

    if (req.get('x-tejaura-csrf') !== '1') {
      res.status(403).json({
        ok: false,
        code: 'CSRF_HEADER_REQUIRED',
        error: 'State-changing requests require the X-TEJAURA-CSRF header.',
      });
      return;
    }

    const candidateHosts = new Set<string>();
    const rawFwdHost = req.get('x-forwarded-host');
    if (rawFwdHost) {
      for (const part of rawFwdHost.split(',')) {
        const normalized = normalizeHostPort(part);
        if (normalized) candidateHosts.add(normalized);
      }
    }
    const rawHost = normalizeHostPort(req.get('host'));
    if (rawHost) candidateHosts.add(rawHost);

    const originHeader = req.get('origin');
    const refererHeader = req.get('referer');

    if (originHeader) {
      try {
        const parsedOrigin = new URL(originHeader);
        if (!candidateHosts.has(normalizeHostPort(parsedOrigin.host))) {
          res.status(403).json({
            ok: false,
            code: 'CSRF_ORIGIN_MISMATCH',
            error: 'Request Origin does not match the control plane host.',
          });
          return;
        }
      } catch {
        res.status(403).json({
          ok: false,
          code: 'CSRF_ORIGIN_INVALID',
          error: 'Malformed Origin header.',
        });
        return;
      }
    } else if (refererHeader) {
      try {
        const parsedRef = new URL(refererHeader);
        if (!candidateHosts.has(normalizeHostPort(parsedRef.host))) {
          res.status(403).json({
            ok: false,
            code: 'CSRF_REFERER_MISMATCH',
            error: 'Request Referer does not match the control plane host.',
          });
          return;
        }
      } catch {
        res.status(403).json({
          ok: false,
          code: 'CSRF_REFERER_INVALID',
          error: 'Malformed Referer header.',
        });
        return;
      }
    }

    next();
  });

  function buildAuthContext(req: Request): AuthRequestContext {
    return {
      protocol: req.protocol,
      encrypted: Boolean(
        (req.socket as { encrypted?: boolean } | undefined)?.encrypted,
      ),
      host: req.get('host'),
      forwardedHost: req.get('x-forwarded-host'),
      forwardedProto: req.get('x-forwarded-proto'),
      secFetchSite: req.get('sec-fetch-site'),
      secFetchDest: req.get('sec-fetch-dest'),
      clientIp: req.ip || req.socket.remoteAddress,
      userAgent: req.get('user-agent'),
      origin: req.get('origin'),
      environment: envMode,
    };
  }

  function requireOwnerAuth(
    permission: Parameters<typeof authorizeRbac>[0]['permission'],
  ) {
    return (req: AuthedRequest, res: Response, next: NextFunction): void => {
      const authRes = auth.authenticateSessionFromCookieHeader(
        req.headers.cookie,
        buildAuthContext(req),
      );
      if (!authRes.ok) {
        const status = authRes.code === 'HTTPS_REQUIRED' ? 426 : 401;
        res.status(status).json({
          ok: false,
          code: authRes.code,
          error: authRes.error,
        });
        return;
      }

      const authz = authorizeRbac({
        principal: authRes.session.toPrincipal(),
        permission,
        resource_id: req.path,
        correlation_id: req.tejauraCorrelationId ?? 'corr_rbac',
        auditLogger,
      });

      if (!authz.allowed) {
        res.status(403).json({
          ok: false,
          code: authz.reason_code,
          error: authz.reason,
        });
        return;
      }

      req.tejauraSession = authRes.session;
      next();
    };
  }

  function sendManagementError(
    res: Response,
    outcome: { code: string; error: string; http_status: number; approval?: unknown },
  ): void {
    const payload: Record<string, unknown> = {
      ok: false,
      code: outcome.code,
      error: outcome.error,
    };
    if (outcome.approval) {
      payload.approval = outcome.approval;
      payload.requires_approval = true;
    }
    res.status(outcome.http_status).json(payload);
  }

  // -------------------- Public / Auth Routes --------------------

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      status: 'ok',
      service: 'tejaura-control-plane',
      primary_runtime: PRIMARY_LOCAL_RUNTIME,
    });
  });

  app.get('/api/auth/status', (req: Request, res: Response) => {
    const initialized = auth.isOwnerInitialized();
    const embeddedFrame =
      (req.get('sec-fetch-dest') ?? '').toLowerCase() === 'iframe' ||
      (req.get('sec-fetch-site') ?? '').toLowerCase() === 'cross-site';
    const authRes = auth.authenticateSessionFromCookieHeader(
      req.headers.cookie,
      buildAuthContext(req),
    );
    if (!authRes.ok) {
      res.json({
        ok: true,
        initialized,
        authenticated: false,
        embedded_frame: embeddedFrame,
        transport_error:
          authRes.code === 'HTTPS_REQUIRED' ? authRes.error : undefined,
      });
      return;
    }

    res.json({
      ok: true,
      initialized: true,
      authenticated: true,
      embedded_frame: embeddedFrame,
      owner: {
        owner_id: authRes.session.owner_id,
        username: authRes.session.username,
        role: authRes.session.role,
        session_id: authRes.session.session_id,
        expires_at: authRes.session.expires_at,
        idle_expires_at: authRes.session.idle_expires_at,
      },
    });
  });

  app.post('/api/auth/setup', async (req: AuthedRequest, res: Response) => {
    if (!isPlainObject(req.body)) {
      res.status(400).json({
        ok: false,
        code: 'INVALID_BODY',
        error: 'Request body must be a JSON object.',
      });
      return;
    }

    const ownerId = sanitizeString(req.body.owner_id, 2, 64) ?? 'owner_primary';
    const username = sanitizeString(req.body.username, 3, 32);
    const email = sanitizeString(req.body.email, 5, 160);
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!username || !email || !password) {
      res.status(400).json({
        ok: false,
        code: 'MISSING_SETUP_FIELDS',
        error: 'username, email, and password are required.',
      });
      return;
    }

    const result = await auth.setupInitialOwner({
      owner_id: ownerId,
      username,
      email,
      password,
      correlation_id: req.tejauraCorrelationId ?? 'corr_setup',
      request: buildAuthContext(req),
    });

    if (!result.ok) {
      const status =
        result.code === 'HTTPS_REQUIRED'
          ? 426
          : result.code === 'OWNER_ALREADY_INITIALIZED'
            ? 409
            : 400;
      res.status(status).json(result);
      return;
    }

    orchestrator.bindDesignatedOwnerId(result.owner_id);
    executionEngine.bindApprovalService(orchestrator.getApprovalService());

    res.status(201).json({
      ok: true,
      owner_id: result.owner_id,
      username: result.username,
      recovery_codes: result.recovery_codes,
    });
  });

  app.post('/api/auth/login', async (req: AuthedRequest, res: Response) => {
    if (!isPlainObject(req.body)) {
      res.status(400).json({
        ok: false,
        code: 'INVALID_BODY',
        error: 'Request body must be a JSON object.',
      });
      return;
    }

    const identifier = sanitizeString(req.body.identifier, 1, 160);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const mfaCode =
      typeof req.body.mfa_code === 'string' && req.body.mfa_code.trim().length > 0
        ? req.body.mfa_code.trim()
        : undefined;

    if (!identifier || !password) {
      res.status(400).json({
        ok: false,
        code: 'MISSING_CREDENTIALS',
        error: 'Identifier and password are required.',
      });
      return;
    }

    const result = await auth.login({
      identifier,
      password,
      mfa_code: mfaCode,
      correlation_id: req.tejauraCorrelationId ?? 'corr_login',
      request: buildAuthContext(req),
    });

    if (!result.ok) {
      const status =
        result.code === 'HTTPS_REQUIRED'
          ? 426
          : result.code === 'RATE_LIMITED'
            ? 429
            : 401;
      if (result.retry_after_seconds) {
        res.setHeader('Retry-After', String(result.retry_after_seconds));
      }
      res.status(status).json(result);
      return;
    }

    res.setHeader('Set-Cookie', result.set_cookie_header);
    res.json({
      ok: true,
      transport_mode: result.transport_mode,
      owner: {
        owner_id: result.session.owner_id,
        username: result.session.username,
        role: result.session.role,
        session_id: result.session.session_id,
        expires_at: result.session.expires_at,
        idle_expires_at: result.session.idle_expires_at,
      },
    });
  });

  app.post('/api/auth/logout', (req: AuthedRequest, res: Response) => {
    const out = auth.logout({
      cookieHeader: req.headers.cookie,
      correlation_id: req.tejauraCorrelationId ?? 'corr_logout',
      request: buildAuthContext(req),
    });
    res.setHeader('Set-Cookie', out.clear_cookie_headers);
    res.json({ ok: true });
  });

  app.post('/api/auth/recover', async (req: AuthedRequest, res: Response) => {
    if (!isPlainObject(req.body)) {
      res.status(400).json({
        ok: false,
        code: 'INVALID_BODY',
        error: 'Request body must be a JSON object.',
      });
      return;
    }

    const identifier = sanitizeString(req.body.identifier, 1, 160);
    const recoveryCode = sanitizeString(req.body.recovery_code, 4, 64);
    const newPassword =
      typeof req.body.new_password === 'string' ? req.body.new_password : '';

    if (!identifier || !recoveryCode || !newPassword) {
      res.status(400).json({
        ok: false,
        code: 'MISSING_RECOVERY_FIELDS',
        error: 'identifier, recovery_code, and new_password are required.',
      });
      return;
    }

    const result = await auth.recoverAccount({
      identifier,
      recovery_code: recoveryCode,
      new_password: newPassword,
      correlation_id: req.tejauraCorrelationId ?? 'corr_recover',
      request: buildAuthContext(req),
    });

    if (!result.ok) {
      const status =
        result.code === 'HTTPS_REQUIRED'
          ? 426
          : result.code === 'RATE_LIMITED'
            ? 429
            : 400;
      res.status(status).json(result);
      return;
    }

    res.json(result);
  });

  // -------------------- Protected Owner Control Plane Routes --------------------

  app.post(
    '/api/auth/mfa/enroll',
    requireOwnerAuth('auth:admin'),
    (req: AuthedRequest, res: Response) => {
      const label =
        isPlainObject(req.body) && typeof req.body.label === 'string'
          ? req.body.label.trim().slice(0, 64)
          : 'Owner Authenticator';
      const result = auth.enrollTotpMfa({
        principal: req.tejauraSession!.toPrincipal(),
        label,
        correlation_id: req.tejauraCorrelationId ?? 'corr_mfa_enroll',
      });
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.status(201).json(result);
    },
  );

  app.post(
    '/api/auth/sessions/revoke-all',
    requireOwnerAuth('auth:admin'),
    (req: AuthedRequest, res: Response) => {
      const result = auth.revokeAllSessions({
        principal: req.tejauraSession!.toPrincipal(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_revoke_all',
      });
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.setHeader('Set-Cookie', result.clear_cookie_header);
      res.json({ ok: true, revoked_count: result.revoked_count });
    },
  );

  app.get(
    '/api/auth/profile',
    requireOwnerAuth('auth:admin'),
    (req: AuthedRequest, res: Response) => {
      const result = auth.getOwnerProfile({
        principal: req.tejauraSession!.toPrincipal(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_profile_get',
      });
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.patch(
    '/api/auth/profile',
    requireOwnerAuth('auth:admin'),
    (req: AuthedRequest, res: Response) => {
      if (!isPlainObject(req.body)) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_BODY',
          error: 'Profile payload must be a JSON object.',
        });
        return;
      }
      const result = auth.updateOwnerProfile({
        principal: req.tejauraSession!.toPrincipal(),
        display_name:
          typeof req.body.display_name === 'string'
            ? req.body.display_name
            : undefined,
        email: typeof req.body.email === 'string' ? req.body.email : undefined,
        timezone:
          typeof req.body.timezone === 'string' ? req.body.timezone : undefined,
        correlation_id: req.tejauraCorrelationId ?? 'corr_profile_update',
      });
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.post(
    '/api/auth/password',
    requireOwnerAuth('auth:admin'),
    async (req: AuthedRequest, res: Response) => {
      if (!isPlainObject(req.body)) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_BODY',
          error: 'Password update payload must be a JSON object.',
        });
        return;
      }
      const currentPassword =
        typeof req.body.current_password === 'string' ? req.body.current_password : '';
      const newPassword =
        typeof req.body.new_password === 'string' ? req.body.new_password : '';
      if (!currentPassword || !newPassword) {
        res.status(400).json({
          ok: false,
          code: 'MISSING_PASSWORD_FIELDS',
          error: 'current_password and new_password are required.',
        });
        return;
      }

      const result = await auth.changePassword({
        principal: req.tejauraSession!.toPrincipal(),
        current_password: currentPassword,
        new_password: newPassword,
        keep_session_id: req.tejauraSession!.session_id,
        correlation_id: req.tejauraCorrelationId ?? 'corr_pw_change',
      });
      if (!result.ok) {
        res.status(result.code === 'INVALID_CURRENT_PASSWORD' ? 401 : 400).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.get(
    '/api/auth/sessions',
    requireOwnerAuth('auth:admin'),
    (req: AuthedRequest, res: Response) => {
      const includeRevoked = req.query.include_revoked === 'true';
      const result = auth.listSessions({
        principal: req.tejauraSession!.toPrincipal(),
        current_session_id: req.tejauraSession!.session_id,
        include_revoked: includeRevoked,
        correlation_id: req.tejauraCorrelationId ?? 'corr_sessions_list',
      });
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.post(
    '/api/auth/sessions/revoke-others',
    requireOwnerAuth('auth:admin'),
    (req: AuthedRequest, res: Response) => {
      const result = auth.revokeOtherSessions({
        principal: req.tejauraSession!.toPrincipal(),
        keep_session_id: req.tejauraSession!.session_id,
        correlation_id: req.tejauraCorrelationId ?? 'corr_revoke_others',
      });
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.post(
    '/api/auth/sessions/:id/revoke',
    requireOwnerAuth('auth:admin'),
    (req: AuthedRequest, res: Response) => {
      const targetId = sanitizeString(req.params.id, 3, 128);
      if (!targetId) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_SESSION_ID',
          error: 'Valid target session ID is required.',
        });
        return;
      }
      const result = auth.revokeSession({
        principal: req.tejauraSession!.toPrincipal(),
        target_session_id: targetId,
        correlation_id: req.tejauraCorrelationId ?? 'corr_revoke_one',
      });
      if (!result.ok) {
        res.status(result.code === 'SESSION_NOT_FOUND_OR_REVOKED' ? 404 : 400).json(result);
        return;
      }
      res.json({
        ok: true,
        revoked_current: targetId === req.tejauraSession!.session_id,
      });
    },
  );

  app.get(
    '/api/auth/mfa',
    requireOwnerAuth('auth:admin'),
    (req: AuthedRequest, res: Response) => {
      const result = auth.listMfaFactors({
        principal: req.tejauraSession!.toPrincipal(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_mfa_list',
      });
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.post(
    '/api/auth/mfa/:id/toggle',
    requireOwnerAuth('auth:admin'),
    async (req: AuthedRequest, res: Response) => {
      const factorId = sanitizeString(req.params.id, 3, 64);
      if (
        !factorId ||
        !isPlainObject(req.body) ||
        typeof req.body.enabled !== 'boolean' ||
        typeof req.body.current_password !== 'string'
      ) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_MFA_TOGGLE',
          error: 'factor_id, boolean enabled, and current_password are required.',
        });
        return;
      }
      const result = await auth.toggleMfaFactor({
        principal: req.tejauraSession!.toPrincipal(),
        factor_id: factorId,
        enabled: req.body.enabled,
        current_password: req.body.current_password,
        correlation_id: req.tejauraCorrelationId ?? 'corr_mfa_toggle',
      });
      if (!result.ok) {
        res.status(result.code === 'INVALID_CURRENT_PASSWORD' ? 401 : 400).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.delete(
    '/api/auth/mfa/:id',
    requireOwnerAuth('auth:admin'),
    async (req: AuthedRequest, res: Response) => {
      const factorId = sanitizeString(req.params.id, 3, 64);
      const currentPassword = isPlainObject(req.body) && typeof req.body.current_password === 'string'
        ? req.body.current_password
        : '';
      if (!factorId || !currentPassword) {
        res.status(400).json({
          ok: false,
          code: 'MISSING_MFA_DELETE_FIELDS',
          error: 'factor_id and current_password are required.',
        });
        return;
      }
      const result = await auth.removeMfaFactor({
        principal: req.tejauraSession!.toPrincipal(),
        factor_id: factorId,
        current_password: currentPassword,
        correlation_id: req.tejauraCorrelationId ?? 'corr_mfa_delete',
      });
      if (!result.ok) {
        res.status(result.code === 'INVALID_CURRENT_PASSWORD' ? 401 : 400).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.post(
    '/api/auth/recovery-codes/regenerate',
    requireOwnerAuth('auth:admin'),
    async (req: AuthedRequest, res: Response) => {
      const currentPassword = isPlainObject(req.body) && typeof req.body.current_password === 'string'
        ? req.body.current_password
        : '';
      if (!currentPassword) {
        res.status(400).json({
          ok: false,
          code: 'CURRENT_PASSWORD_REQUIRED',
          error: 'Current password is required to regenerate recovery codes.',
        });
        return;
      }
      const result = await auth.regenerateRecoveryCodes({
        principal: req.tejauraSession!.toPrincipal(),
        current_password: currentPassword,
        correlation_id: req.tejauraCorrelationId ?? 'corr_recovery_regen',
      });
      if (!result.ok) {
        res.status(result.code === 'INVALID_CURRENT_PASSWORD' ? 401 : 400).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.get(
    '/api/system/overview',
    requireOwnerAuth('governance:read'),
    (req: AuthedRequest, res: Response) => {
      const session = req.tejauraSession!;
      const nowIso = clock().toISOString();
      const tasks = orchestrator.listTasks({ limit: 500 });
      const taskCounts: Record<TaskStatus, number> = {
        queued: 0,
        running: 0,
        waiting_for_approval: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      };
      for (const task of tasks) {
        taskCounts[task.status] = (taskCounts[task.status] ?? 0) + 1;
      }

      const approvals = orchestrator.listApprovals();
      const pendingApprovals = approvals.filter((a) => a.status === 'pending').length;
      const schedules = orchestrator.listSchedules();
      const models = registry.listModels();
      const nodes = hardware.listNodes();
      const trustedEndpoints = runtime.listTrustedEndpoints();
      const lifecycleStats = lifecycle.getStats();
      const secretsMeta = secretsManager.listMetadata({
        principal: session.toPrincipal(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_sec_meta',
      });
      const identitySnap = identityStore.load();
      const activeSessionsCount = identitySnap.sessions.filter(
        (s) => s.revoked_at === null && new Date(s.expires_at).getTime() > clock().getTime(),
      ).length;
      const sysCfg = systemConfig as Record<string, unknown>;

      res.json({
        ok: true,
        generated_at: nowIso,
        owner: {
          owner_id: session.owner_id,
          username: session.username,
          role: session.role,
          session_id: session.session_id,
          expires_at: session.expires_at,
          idle_expires_at: session.idle_expires_at,
        },
        persistence: {
          engine: 'sqlite',
          migrations_applied: store.getAppliedMigrations(),
        },
        worker: {
          worker_id: orchestrator.getWorkerId(),
          active_leases: store.countActiveLeases(nowIso),
          lifecycle: lifecycleStats,
          primary_runtime: PRIMARY_LOCAL_RUNTIME,
          paid_api_fallback_enabled: false,
        },
        counts: {
          tasks_by_status: taskCounts,
          total_tasks: tasks.length,
          pending_approvals: pendingApprovals,
          active_schedules: schedules.filter((s) => s.enabled).length,
          total_schedules: schedules.length,
          registered_models: models.length,
          verified_enabled_models: models.filter(
            (m) => m.enabled && m.compatibility_status === 'verified',
          ).length,
          online_compute_nodes: nodes.filter((n) => n.online).length,
          trusted_endpoints: trustedEndpoints.length,
        },
        action_catalog: Object.values(POLICY_ACTION_CATALOG).map((spec) => ({
          action: spec.action,
          required_autonomy: spec.required_autonomy,
          required_scope: spec.required_scope,
          owner_exclusive: spec.owner_exclusive,
          allowed_environments: spec.allowed_environments,
          description: spec.description,
        })),
        trusted_endpoints: trustedEndpoints.map((ep) => ({
          endpoint_id: ep.endpoint_id,
          runtime_type: ep.runtime_type,
          base_url: ep.base_url,
          node_id: ep.node_id,
          enabled: ep.enabled,
          requires_auth: ep.requires_auth ?? false,
          auth_token_env_var: ep.auth_token_env_var ?? null,
        })),
        secrets_inventory: secretsMeta.ok ? secretsMeta.value : [],
        system_governance: {
          system: sysCfg.system ?? null,
          principles: sysCfg.principles ?? null,
          governance: sysCfg.governance ?? null,
          approval_gates: sysCfg.approvalGates ?? null,
          security: sysCfg.security ?? null,
        },
        rbac_roles: ROLE_PERMISSIONS,
        auth_posture: {
          mfa_enrolled_count:
            identitySnap.owner?.mfa_factors.filter((f) => f.enabled).length ?? 0,
          recovery_codes_remaining:
            identitySnap.owner?.recovery_codes.filter((c) => c.used_at === null).length ?? 0,
          active_sessions_count: activeSessionsCount,
          cookie_name: securityConfig.session.cookieName,
          same_site: securityConfig.session.sameSite,
          http_only: securityConfig.session.httpOnly,
          secure_cookie: securityConfig.session.secure,
          enforce_https_in_deployment: securityConfig.transport.enforceHttpsInDeployment,
        },
      });
    },
  );

  app.get(
    '/api/tasks',
    requireOwnerAuth('governance:read'),
    (req: Request, res: Response) => {
      const rawStatus =
        typeof req.query.status === 'string' ? req.query.status.trim() : undefined;
      let statusFilter: TaskStatus | undefined;
      if (rawStatus) {
        if (!VALID_TASK_STATUSES.has(rawStatus as TaskStatus)) {
          res.status(400).json({
            ok: false,
            code: 'INVALID_STATUS_FILTER',
            error: `Unsupported task status filter "${rawStatus}".`,
          });
          return;
        }
        statusFilter = rawStatus as TaskStatus;
      }

      const rawLimit =
        typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
      const limit = Number.isFinite(rawLimit)
        ? Math.min(250, Math.max(1, Math.round(rawLimit)))
        : 100;

      res.json({
        ok: true,
        tasks: orchestrator.listTasks({ status: statusFilter, limit }),
      });
    },
  );

  app.post(
    '/api/tasks',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      if (!isPlainObject(req.body)) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_BODY',
          error: 'Task payload must be a JSON object.',
        });
        return;
      }

      const title = sanitizeString(req.body.title, 2, 160);
      const description = sanitizeString(req.body.description, 2, 2000);
      const action = sanitizeString(req.body.action, 2, 80);
      const resourceId = sanitizeString(req.body.resource_id, 2, 160);
      const taskType = sanitizeString(req.body.type, 2, 64) ?? action?.replace(/:/g, '.') ?? null;
      const environment = req.body.environment as ExecutionEnvironment;
      const autonomyLevel = req.body.autonomy_level as AutonomyLevel;

      if (
        !title ||
        !description ||
        !action ||
        !resourceId ||
        !taskType ||
        !VALID_ENVIRONMENTS.has(environment) ||
        !VALID_AUTONOMY.has(autonomyLevel)
      ) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_TASK_FIELDS',
          error:
            'Valid title, description, action, resource_id, environment, and autonomy_level are required.',
        });
        return;
      }

      const declaredScopes = Array.isArray(req.body.declared_scopes)
        ? req.body.declared_scopes.filter(
            (s): s is string => typeof s === 'string' && s.trim().length > 0,
          )
        : [];

      const priority =
        typeof req.body.priority === 'number' && Number.isFinite(req.body.priority)
          ? req.body.priority
          : 50;
      const maxRetries =
        typeof req.body.max_retries === 'number' && Number.isFinite(req.body.max_retries)
          ? req.body.max_retries
          : 0;
      const timeoutMs =
        typeof req.body.timeout_ms === 'number' && Number.isFinite(req.body.timeout_ms)
          ? req.body.timeout_ms
          : 30_000;
      const idempotencyKey =
        typeof req.body.idempotency_key === 'string' &&
        req.body.idempotency_key.trim().length > 0
          ? req.body.idempotency_key.trim().slice(0, 128)
          : undefined;
      const deadlineAt =
        typeof req.body.deadline_at === 'string' &&
        req.body.deadline_at.trim().length > 0
          ? req.body.deadline_at.trim()
          : null;
      const inputObj = isPlainObject(req.body.input) ? req.body.input : {};

      const result = orchestrator.submitTask(
        {
          type: taskType,
          title,
          description,
          action,
          resource_id: resourceId,
          environment,
          autonomy_level: autonomyLevel,
          declared_scopes: declaredScopes,
          priority,
          idempotency_key: idempotencyKey,
          idempotent_action:
            typeof req.body.idempotent_action === 'boolean'
              ? req.body.idempotent_action
              : true,
          deadline_at: deadlineAt,
          max_retries: maxRetries,
          timeout_ms: timeoutMs,
          input: inputObj,
        },
        {
          actor: req.tejauraSession!.toPolicyActor(),
          correlation_id: req.tejauraCorrelationId ?? 'corr_task_create',
        },
      );

      if (!result.ok) {
        const status =
          result.code === 'CONTRACT_VALIDATION_FAILED' ||
          result.code === 'UNKNOWN_ACTION' ||
          result.code === 'INVALID_DEADLINE'
            ? 400
            : 403;
        res.status(status).json(result);
        return;
      }

      res.status(result.duplicate ? 200 : 201).json(result);
    },
  );

  app.get(
    '/api/tasks/:id',
    requireOwnerAuth('governance:read'),
    (req: Request, res: Response) => {
      const taskId = sanitizeString(req.params.id, 3, 128);
      if (!taskId) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_TASK_ID',
          error: 'Invalid task ID.',
        });
        return;
      }
      const detail = orchestrator.getTaskDetail(taskId);
      if (!detail) {
        res.status(404).json({
          ok: false,
          code: 'TASK_NOT_FOUND',
          error: `Task "${taskId}" was not found.`,
        });
        return;
      }
      res.json({ ok: true, ...detail });
    },
  );

  app.post(
    '/api/tasks/:id/cancel',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const taskId = sanitizeString(req.params.id, 3, 128);
      if (!taskId) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_TASK_ID',
          error: 'Invalid task ID.',
        });
        return;
      }
      const reason =
        isPlainObject(req.body) && typeof req.body.reason === 'string'
          ? req.body.reason.trim().slice(0, 300)
          : 'Cancelled by owner from control plane.';

      const result = orchestrator.cancelTask({
        taskId,
        actor: req.tejauraSession!.toPolicyActor(),
        reason,
        correlation_id: req.tejauraCorrelationId ?? 'corr_task_cancel',
      });
      if (!result.ok) {
        const status =
          result.code === 'TASK_NOT_FOUND'
            ? 404
            : result.code === 'TASK_ALREADY_TERMINAL'
              ? 409
              : 403;
        res.status(status).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.post(
    '/api/tasks/:id/retry',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const taskId = sanitizeString(req.params.id, 3, 128);
      if (!taskId) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_TASK_ID',
          error: 'Invalid task ID.',
        });
        return;
      }
      const confirmNonIdempotent =
        isPlainObject(req.body) && req.body.confirm_non_idempotent_retry === true;
      const result = orchestrator.retryTask({
        taskId,
        actor: req.tejauraSession!.toPolicyActor(),
        confirmNonIdempotentRetry: confirmNonIdempotent,
        correlation_id: req.tejauraCorrelationId ?? 'corr_task_retry',
      });
      if (!result.ok) {
        const status =
          result.code === 'TASK_NOT_FOUND'
            ? 404
            : result.code === 'NON_IDEMPOTENT_CONFIRMATION_REQUIRED' ||
                result.code === 'TASK_NOT_RETRYABLE_STATUS'
              ? 409
              : 403;
        res.status(status).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.get(
    '/api/schedules',
    requireOwnerAuth('governance:read'),
    (_req: Request, res: Response) => {
      res.json({ ok: true, schedules: orchestrator.listSchedules() });
    },
  );

  app.post(
    '/api/schedules',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      if (!isPlainObject(req.body) || !isPlainObject(req.body.task_template)) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_SCHEDULE_PAYLOAD',
          error: 'Schedule payload and task_template object are required.',
        });
        return;
      }

      const name = sanitizeString(req.body.name, 2, 120);
      const description = sanitizeString(req.body.description, 2, 500);
      const intervalSeconds =
        typeof req.body.interval_seconds === 'number'
          ? Math.round(req.body.interval_seconds)
          : 0;
      const tmplRaw = req.body.task_template;
      const tmplAction = sanitizeString(tmplRaw.action, 2, 80);
      const tmplTitle = sanitizeString(tmplRaw.title, 2, 140);
      const tmplDesc = sanitizeString(tmplRaw.description, 2, 1000);
      const tmplResource = sanitizeString(tmplRaw.resource_id, 2, 160);
      const tmplEnv = tmplRaw.environment as ExecutionEnvironment;
      const tmplAutonomy = tmplRaw.autonomy_level as AutonomyLevel;

      if (
        !name ||
        !description ||
        !tmplAction ||
        !tmplTitle ||
        !tmplDesc ||
        !tmplResource ||
        !VALID_ENVIRONMENTS.has(tmplEnv) ||
        !VALID_AUTONOMY.has(tmplAutonomy)
      ) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_SCHEDULE_FIELDS',
          error: 'Invalid schedule or task_template fields.',
        });
        return;
      }

      const template: ScheduleTaskTemplate = {
        type: sanitizeString(tmplRaw.type, 2, 64) ?? tmplAction.replace(/:/g, '.'),
        title: tmplTitle,
        description: tmplDesc,
        action: tmplAction,
        resource_id: tmplResource,
        environment: tmplEnv,
        autonomy_level: tmplAutonomy,
        declared_scopes: Array.isArray(tmplRaw.declared_scopes)
          ? tmplRaw.declared_scopes.filter(
              (s): s is string => typeof s === 'string' && s.trim().length > 0,
            )
          : [],
        priority:
          typeof tmplRaw.priority === 'number' && Number.isFinite(tmplRaw.priority)
            ? Math.min(100, Math.max(0, Math.round(tmplRaw.priority)))
            : 50,
        idempotent_action:
          typeof tmplRaw.idempotent_action === 'boolean'
            ? tmplRaw.idempotent_action
            : true,
        max_retries:
          typeof tmplRaw.max_retries === 'number' && Number.isFinite(tmplRaw.max_retries)
            ? Math.min(5, Math.max(0, Math.round(tmplRaw.max_retries)))
            : 0,
        timeout_ms:
          typeof tmplRaw.timeout_ms === 'number' && Number.isFinite(tmplRaw.timeout_ms)
            ? Math.min(300_000, Math.max(500, Math.round(tmplRaw.timeout_ms)))
            : 30_000,
        input: isPlainObject(tmplRaw.input) ? tmplRaw.input : {},
      };

      const result = orchestrator.createSchedule(
        {
          name,
          description,
          interval_seconds: intervalSeconds,
          enabled: typeof req.body.enabled === 'boolean' ? req.body.enabled : true,
          task_template: template,
        },
        req.tejauraSession!.toPolicyActor(),
        req.tejauraCorrelationId ?? 'corr_sched_create',
      );

      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.status(201).json(result);
    },
  );

  app.post(
    '/api/schedules/:id/toggle',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const scheduleId = sanitizeString(req.params.id, 3, 128);
      if (!scheduleId || !isPlainObject(req.body) || typeof req.body.enabled !== 'boolean') {
        res.status(400).json({
          ok: false,
          code: 'INVALID_SCHEDULE_TOGGLE',
          error: 'Schedule ID and boolean enabled flag are required.',
        });
        return;
      }

      const result = orchestrator.toggleSchedule({
        scheduleId,
        enabled: req.body.enabled,
        actor: req.tejauraSession!.toPolicyActor(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_sched_toggle',
      });
      if (!result.ok) {
        res.status(result.code === 'SCHEDULE_NOT_FOUND' ? 404 : 403).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.get(
    '/api/approvals',
    requireOwnerAuth('governance:read'),
    (_req: Request, res: Response) => {
      res.json({
        ok: true,
        approvals: orchestrator.listApprovals(),
      });
    },
  );

  app.post(
    '/api/approvals/:id/decide',
    requireOwnerAuth('approval:decide'),
    (req: AuthedRequest, res: Response) => {
      const approvalId = sanitizeString(req.params.id, 3, 128);
      if (!approvalId || !isPlainObject(req.body)) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_APPROVAL_DECISION',
          error: 'Approval ID and JSON decision body are required.',
        });
        return;
      }

      const decision = req.body.decision;
      const reason = sanitizeString(req.body.reason, 2, 500);
      if (
        (decision !== 'approved' && decision !== 'rejected') ||
        !reason
      ) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_APPROVAL_FIELDS',
          error: 'decision ("approved" | "rejected") and non-empty reason are required.',
        });
        return;
      }

      const existingApr = orchestrator.getApprovalService().getApproval(approvalId);
      if (existingApr && existingApr.task_id.startsWith('proj_')) {
        const projRes = management.decideProjectApproval({
          approval_id: approvalId,
          decision,
          reviewer: req.tejauraSession!.toTrustedReviewerContext(),
          reason,
          correlation_id: req.tejauraCorrelationId ?? 'corr_approval_decide',
        });
        if (!projRes.ok) {
          res.status(projRes.http_status).json({
            ok: false,
            code: projRes.code,
            error: projRes.error,
          });
          return;
        }
        res.json({
          ok: true,
          approval: projRes.data.approval,
          project: projRes.data.project,
          task: null,
        });
        return;
      }

      const result = orchestrator.decideApprovalAndResumeTask({
        approval_id: approvalId,
        decision,
        reviewer: req.tejauraSession!.toTrustedReviewerContext(),
        reason,
        correlation_id: req.tejauraCorrelationId ?? 'corr_approval_decide',
      });

      if (!result.ok) {
        const status =
          result.code === 'APPROVAL_NOT_FOUND'
            ? 404
            : result.code === 'APPROVAL_ALREADY_DECIDED' ||
                result.code === 'APPROVAL_EXPIRED'
              ? 409
              : 403;
        res.status(status).json(result);
        return;
      }

      res.json(result);
    },
  );

  app.get(
    '/api/models',
    requireOwnerAuth('governance:read'),
    (req: Request, res: Response) => {
      const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
      const rawOffset = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
      const limit = Number.isFinite(rawLimit) ? Math.min(250, Math.max(1, Math.round(rawLimit))) : 100;
      const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.round(rawOffset)) : 0;
      const runtimeFilter = typeof req.query.runtime === 'string' ? req.query.runtime.trim() : undefined;

      const paged = management.listManagedModels({
        runtimeType: runtimeFilter || undefined,
        limit,
        offset,
      });
      const models = paged.items.map((model) => ({
        ...model,
        breaker: lifecycle.getBreakerState(model.model_id),
      }));

      res.json({
        ok: true,
        primary_runtime: PRIMARY_LOCAL_RUNTIME,
        models,
        total: paged.total,
        limit,
        offset,
        compute_nodes: hardware.listNodes(),
        trusted_endpoints: runtime.listTrustedEndpoints().map((ep) => ({
          endpoint_id: ep.endpoint_id,
          runtime_type: ep.runtime_type,
          base_url: ep.base_url,
          node_id: ep.node_id,
          enabled: ep.enabled,
          requires_auth: ep.requires_auth ?? false,
          auth_token_env_var: ep.auth_token_env_var ?? null,
        })),
        lifecycle_stats: lifecycle.getStats(),
      });
    },
  );

  app.post(
    '/api/models',
    requireOwnerAuth('model:registry:write'),
    (req: AuthedRequest, res: Response) => {
      if (!isPlainObject(req.body)) {
        res.status(400).json({ ok: false, code: 'INVALID_BODY', error: 'Model payload must be a JSON object.' });
        return;
      }
      const outcome = management.addOrUpdateModel(req.body, {
        actor: req.tejauraSession!.toPolicyActor(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_model_create',
      });
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.status(201).json({ ok: true, model: outcome.data });
    },
  );

  app.patch(
    '/api/models/:id',
    requireOwnerAuth('model:registry:write'),
    (req: AuthedRequest, res: Response) => {
      const modelId = sanitizeString(req.params.id, 2, 128);
      if (!modelId || !isPlainObject(req.body)) {
        res.status(400).json({ ok: false, code: 'INVALID_MODEL_UPDATE', error: 'Valid model ID and JSON body required.' });
        return;
      }
      const outcome = management.addOrUpdateModel(
        req.body,
        {
          actor: req.tejauraSession!.toPolicyActor(),
          correlation_id: req.tejauraCorrelationId ?? 'corr_model_update',
        },
        modelId,
      );
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, model: outcome.data });
    },
  );

  app.delete(
    '/api/models/:id',
    requireOwnerAuth('model:registry:write'),
    (req: AuthedRequest, res: Response) => {
      const modelId = sanitizeString(req.params.id, 2, 128);
      if (!modelId) {
        res.status(400).json({ ok: false, code: 'INVALID_MODEL_ID', error: 'Invalid model ID.' });
        return;
      }
      const outcome = management.deleteModel(modelId, {
        actor: req.tejauraSession!.toPolicyActor(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_model_delete',
      });
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, ...outcome.data });
    },
  );

  app.post(
    '/api/models/:id/toggle',
    requireOwnerAuth('model:registry:write'),
    (req: AuthedRequest, res: Response) => {
      const modelId = sanitizeString(req.params.id, 2, 128);
      if (!modelId || !isPlainObject(req.body) || typeof req.body.enabled !== 'boolean') {
        res.status(400).json({ ok: false, code: 'INVALID_MODEL_TOGGLE', error: 'Model ID and boolean enabled flag required.' });
        return;
      }
      const outcome = management.toggleModel(modelId, req.body.enabled, {
        actor: req.tejauraSession!.toPolicyActor(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_model_toggle',
      });
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, model: outcome.data });
    },
  );

  app.post(
    '/api/models/:id/role',
    requireOwnerAuth('model:registry:write'),
    (req: AuthedRequest, res: Response) => {
      const modelId = sanitizeString(req.params.id, 2, 128);
      const role = isPlainObject(req.body) ? req.body.role : null;
      if (!modelId || (role !== 'default' && role !== 'backup')) {
        res.status(400).json({ ok: false, code: 'INVALID_MODEL_ROLE', error: 'Model ID and role ("default" | "backup") required.' });
        return;
      }
      const outcome = management.setModelRole(modelId, role, {
        actor: req.tejauraSession!.toPolicyActor(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_model_role',
      });
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, model: outcome.data });
    },
  );

  app.post(
    '/api/models/:id/verify-install',
    requireOwnerAuth('model:registry:write'),
    async (req: AuthedRequest, res: Response) => {
      const modelId = sanitizeString(req.params.id, 2, 128);
      if (!modelId) {
        res.status(400).json({ ok: false, code: 'INVALID_MODEL_ID', error: 'Invalid model ID.' });
        return;
      }
      const outcome = await management.verifyModelInstall(modelId, {
        actor: req.tejauraSession!.toPolicyActor(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_model_verify',
      });
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, model: outcome.data });
    },
  );

  app.post(
    '/api/models/:id/probe',
    requireOwnerAuth('model:discover:local'),
    async (req: Request, res: Response) => {
      const modelId = sanitizeString(req.params.id, 2, 128);
      if (!modelId) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_MODEL_ID',
          error: 'Invalid model ID.',
        });
        return;
      }
      const probe = await lifecycle.checkAvailability(modelId, {
        probeRuntime: true,
        timeoutMs: 5000,
      });
      res.status(probe.code === 'MODEL_NOT_FOUND' ? 404 : 200).json({
        ok: true,
        probe,
      });
    },
  );

  app.post(
    '/api/worker/tick',
    requireOwnerAuth('governance:write'),
    async (_req: Request, res: Response) => {
      const report = await orchestrator.runWorkerTick();
      res.json({ ok: true, report });
    },
  );

  app.get(
    '/api/audit',
    requireOwnerAuth('audit:read'),
    (_req: Request, res: Response) => {
      if (auditStorage instanceof InMemoryAuditStorage) {
        const events = auditStorage.getEvents();
        res.json({
          ok: true,
          events: events.slice(-100).reverse(),
        });
        return;
      }

      if (auditStorage instanceof JsonlAuditStorage) {
        const filePath = auditStorage.getFilePath();
        if (!filePath || !fs.existsSync(filePath)) {
          res.json({ ok: true, events: [] });
          return;
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-100)
          .reverse();
        const events = lines.map((line) => JSON.parse(line) as unknown);
        res.json({ ok: true, events });
        return;
      }

      res.json({ ok: true, events: [] });
    },
  );

  // -------------------- Stage 4 Sandboxed Agent Execution Routes --------------------

  app.get(
    '/api/execution/adapters',
    requireOwnerAuth('governance:read'),
    (_req: Request, res: Response) => {
      res.json({
        ok: true,
        adapters: executionEngine.listAdapters(),
      });
    },
  );

  app.get(
    '/api/execution/jobs',
    requireOwnerAuth('governance:read'),
    (req: Request, res: Response) => {
      const statusParam =
        typeof req.query.status === 'string' ? req.query.status.trim() : undefined;
      const taskId =
        typeof req.query.task_id === 'string' ? req.query.task_id.trim() : undefined;
      const agentId =
        typeof req.query.agent_id === 'string' ? req.query.agent_id.trim() : undefined;
      const rawLimit =
        typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
      const limit = Number.isFinite(rawLimit)
        ? Math.min(250, Math.max(1, Math.round(rawLimit)))
        : 100;

      const validStatuses = new Set([
        'queued',
        'running',
        'completed',
        'failed',
        'cancelled',
      ]);
      if (statusParam && !validStatuses.has(statusParam)) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_JOB_STATUS',
          error: `Unsupported execution job status "${statusParam}".`,
        });
        return;
      }

      res.json({
        ok: true,
        jobs: executionEngine.listJobs({
          status: statusParam as Parameters<
            AgentExecutionEngine['listJobs']
          >[0] extends infer F
            ? F extends { status?: infer S }
              ? S
              : never
            : never,
          taskId,
          agentId,
          limit,
        }),
      });
    },
  );

  app.get(
    '/api/execution/jobs/:id',
    requireOwnerAuth('governance:read'),
    (req: Request, res: Response) => {
      const jobId = sanitizeString(req.params.id, 3, 128);
      if (!jobId) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_JOB_ID',
          error: 'Invalid execution job ID.',
        });
        return;
      }
      const job = executionEngine.getJob(jobId);
      if (!job) {
        res.status(404).json({
          ok: false,
          code: 'JOB_NOT_FOUND',
          error: `Execution job "${jobId}" was not found.`,
        });
        return;
      }
      res.json({
        ok: true,
        job,
        logs: executionEngine.listExecutionLogs({ jobId }),
      });
    },
  );

  app.post(
    '/api/execution/jobs/:id/cancel',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const jobId = sanitizeString(req.params.id, 3, 128);
      if (!jobId) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_JOB_ID',
          error: 'Invalid execution job ID.',
        });
        return;
      }
      const reason =
        isPlainObject(req.body) && typeof req.body.reason === 'string'
          ? req.body.reason.trim().slice(0, 300)
          : 'Cancelled by owner from control plane.';

      const result = executionEngine.cancelJob({
        jobId,
        actor: req.tejauraSession!.toPolicyActor(),
        reason,
        correlation_id: req.tejauraCorrelationId ?? 'corr_exec_job_cancel',
      });
      if (!result.ok) {
        const status =
          result.code === 'JOB_NOT_FOUND'
            ? 404
            : result.code === 'JOB_ALREADY_TERMINAL'
              ? 409
              : 403;
        res.status(status).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.get(
    '/api/execution/logs',
    requireOwnerAuth('audit:read'),
    (req: Request, res: Response) => {
      const jobId =
        typeof req.query.job_id === 'string' ? req.query.job_id.trim() : undefined;
      const taskId =
        typeof req.query.task_id === 'string' ? req.query.task_id.trim() : undefined;
      const agentId =
        typeof req.query.agent_id === 'string' ? req.query.agent_id.trim() : undefined;
      const rawLimit =
        typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
      const limit = Number.isFinite(rawLimit)
        ? Math.min(250, Math.max(1, Math.round(rawLimit)))
        : 100;

      res.json({
        ok: true,
        logs: executionEngine.listExecutionLogs({
          jobId,
          taskId,
          agentId,
          limit,
        }),
      });
    },
  );

  // -------------------- Stage 4.5 Owner Management Center Routes --------------------

  app.get(
    '/api/agents',
    requireOwnerAuth('governance:read'),
    (req: Request, res: Response) => {
      const department =
        typeof req.query.department === 'string' ? req.query.department.trim() : undefined;
      const status =
        typeof req.query.status === 'string' ? req.query.status.trim() : undefined;
      const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
      const rawOffset = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
      const limit = Number.isFinite(rawLimit) ? Math.min(250, Math.max(1, Math.round(rawLimit))) : 50;
      const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.round(rawOffset)) : 0;
      const paged = management.listAgents({ department, status, limit, offset });
      res.json({
        ok: true,
        agents: paged.items,
        total: paged.total,
        limit,
        offset,
      });
    },
  );

  app.post(
    '/api/agents',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      if (!isPlainObject(req.body)) {
        res.status(400).json({ ok: false, code: 'INVALID_BODY', error: 'Agent payload must be a JSON object.' });
        return;
      }
      const outcome = management.createOrUpdateAgent(req.body, {
        actor: req.tejauraSession!.toPolicyActor(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_agent_create',
      });
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.status(201).json({ ok: true, agent: outcome.data });
    },
  );

  app.patch(
    '/api/agents/:id',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const agentId = sanitizeString(req.params.id, 2, 128);
      if (!agentId || !isPlainObject(req.body)) {
        res.status(400).json({ ok: false, code: 'INVALID_AGENT_UPDATE', error: 'Valid agent ID and JSON body required.' });
        return;
      }
      const outcome = management.createOrUpdateAgent(
        req.body,
        {
          actor: req.tejauraSession!.toPolicyActor(),
          correlation_id: req.tejauraCorrelationId ?? 'corr_agent_update',
        },
        agentId,
      );
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, agent: outcome.data });
    },
  );

  app.post(
    '/api/agents/:id/status',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const agentId = sanitizeString(req.params.id, 2, 128);
      if (
        !agentId ||
        !isPlainObject(req.body) ||
        typeof req.body.status !== 'string'
      ) {
        res.status(400).json({ ok: false, code: 'INVALID_AGENT_STATUS', error: 'Agent ID and status required.' });
        return;
      }
      const enabled = typeof req.body.enabled === 'boolean' ? req.body.enabled : req.body.status === 'active';
      const outcome = management.setAgentStatus(
        agentId,
        req.body.status as Parameters<ManagementService['setAgentStatus']>[1],
        enabled,
        {
          actor: req.tejauraSession!.toPolicyActor(),
          correlation_id: req.tejauraCorrelationId ?? 'corr_agent_status',
        },
      );
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, agent: outcome.data });
    },
  );

  app.get(
    '/api/agents/:id/history',
    requireOwnerAuth('governance:read'),
    (req: Request, res: Response) => {
      const agentId = sanitizeString(req.params.id, 2, 128);
      if (!agentId) {
        res.status(400).json({ ok: false, code: 'INVALID_AGENT_ID', error: 'Invalid agent ID.' });
        return;
      }
      const outcome = management.getAgentHistory(agentId);
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, ...outcome.data });
    },
  );

  app.get(
    '/api/workers',
    requireOwnerAuth('governance:read'),
    (req: Request, res: Response) => {
      const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
      const rawOffset = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
      const limit = Number.isFinite(rawLimit) ? Math.min(250, Math.max(1, Math.round(rawLimit))) : 50;
      const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.round(rawOffset)) : 0;
      const paged = management.listWorkers(limit, offset);
      res.json({
        ok: true,
        workers: paged.items,
        total: paged.total,
        limit,
        offset,
      });
    },
  );

  app.post(
    '/api/workers',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      if (!isPlainObject(req.body)) {
        res.status(400).json({ ok: false, code: 'INVALID_BODY', error: 'Worker payload must be a JSON object.' });
        return;
      }
      const outcome = management.registerOrUpdateWorker(
        req.body,
        {
          actor: req.tejauraSession!.toPolicyActor(),
          correlation_id: req.tejauraCorrelationId ?? 'corr_worker_create',
        },
        undefined,
        typeof req.body.approval_id === 'string' ? req.body.approval_id : undefined,
      );
      if (!outcome.ok) {
        sendManagementError(res, outcome);
        return;
      }
      res.status(201).json({ ok: true, worker: outcome.data });
    },
  );

  app.patch(
    '/api/workers/:id',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const workerId = sanitizeString(req.params.id, 2, 128);
      if (!workerId || !isPlainObject(req.body)) {
        res.status(400).json({ ok: false, code: 'INVALID_WORKER_UPDATE', error: 'Worker ID and JSON body required.' });
        return;
      }
      const outcome = management.registerOrUpdateWorker(
        req.body,
        {
          actor: req.tejauraSession!.toPolicyActor(),
          correlation_id: req.tejauraCorrelationId ?? 'corr_worker_update',
        },
        workerId,
        typeof req.body.approval_id === 'string' ? req.body.approval_id : undefined,
      );
      if (!outcome.ok) {
        sendManagementError(res, outcome);
        return;
      }
      res.json({ ok: true, worker: outcome.data });
    },
  );

  app.post(
    '/api/workers/:id/toggle',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const workerId = sanitizeString(req.params.id, 2, 128);
      if (!workerId || !isPlainObject(req.body) || typeof req.body.enabled !== 'boolean') {
        res.status(400).json({ ok: false, code: 'INVALID_WORKER_TOGGLE', error: 'Worker ID and boolean enabled flag required.' });
        return;
      }
      const outcome = management.toggleWorker(
        workerId,
        req.body.enabled,
        {
          actor: req.tejauraSession!.toPolicyActor(),
          correlation_id: req.tejauraCorrelationId ?? 'corr_worker_toggle',
        },
        typeof req.body.approval_id === 'string' ? req.body.approval_id : undefined,
      );
      if (!outcome.ok) {
        sendManagementError(res, outcome);
        return;
      }
      res.json({ ok: true, worker: outcome.data });
    },
  );

  app.post(
    '/api/workers/:id/probe',
    requireOwnerAuth('model:discover:local'),
    async (req: AuthedRequest, res: Response) => {
      const workerId = sanitizeString(req.params.id, 2, 128);
      if (!workerId) {
        res.status(400).json({ ok: false, code: 'INVALID_WORKER_ID', error: 'Invalid worker ID.' });
        return;
      }
      const outcome = await management.probeWorker(workerId, {
        actor: req.tejauraSession!.toPolicyActor(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_worker_probe',
      });
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, worker: outcome.data });
    },
  );

  app.delete(
    '/api/workers/:id',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const workerId = sanitizeString(req.params.id, 2, 128);
      if (!workerId) {
        res.status(400).json({ ok: false, code: 'INVALID_WORKER_ID', error: 'Invalid worker ID.' });
        return;
      }
      const approvalId =
        typeof req.query.approval_id === 'string'
          ? req.query.approval_id
          : isPlainObject(req.body) && typeof req.body.approval_id === 'string'
            ? req.body.approval_id
            : undefined;
      const outcome = management.deleteWorker(
        workerId,
        {
          actor: req.tejauraSession!.toPolicyActor(),
          correlation_id: req.tejauraCorrelationId ?? 'corr_worker_delete',
        },
        approvalId,
      );
      if (!outcome.ok) {
        sendManagementError(res, outcome);
        return;
      }
      res.json({ ok: true, ...outcome.data });
    },
  );

  app.get(
    '/api/projects',
    requireOwnerAuth('governance:read'),
    (req: Request, res: Response) => {
      const environment =
        typeof req.query.environment === 'string' ? req.query.environment.trim() : undefined;
      const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
      const rawOffset = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
      const limit = Number.isFinite(rawLimit) ? Math.min(250, Math.max(1, Math.round(rawLimit))) : 50;
      const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.round(rawOffset)) : 0;
      const paged = management.listProjects({ environment, limit, offset });
      res.json({
        ok: true,
        projects: paged.items,
        total: paged.total,
        limit,
        offset,
      });
    },
  );

  app.post(
    '/api/projects',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      if (!isPlainObject(req.body)) {
        res.status(400).json({ ok: false, code: 'INVALID_BODY', error: 'Project payload must be a JSON object.' });
        return;
      }
      const outcome = management.createOrUpdateProject(req.body, {
        actor: req.tejauraSession!.toPolicyActor(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_proj_create',
      });
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.status(201).json({ ok: true, project: outcome.data });
    },
  );

  app.patch(
    '/api/projects/:id',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const projectId = sanitizeString(req.params.id, 2, 128);
      if (!projectId || !isPlainObject(req.body)) {
        res.status(400).json({ ok: false, code: 'INVALID_PROJECT_UPDATE', error: 'Project ID and JSON body required.' });
        return;
      }
      const outcome = management.createOrUpdateProject(
        req.body,
        {
          actor: req.tejauraSession!.toPolicyActor(),
          correlation_id: req.tejauraCorrelationId ?? 'corr_proj_update',
        },
        projectId,
      );
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, project: outcome.data });
    },
  );

  app.post(
    '/api/projects/:id/deploy',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const projectId = sanitizeString(req.params.id, 2, 128);
      if (!projectId) {
        res.status(400).json({ ok: false, code: 'INVALID_PROJECT_ID', error: 'Invalid project ID.' });
        return;
      }
      const bodyObj = isPlainObject(req.body) ? req.body : {};
      const outcome = management.deployProject(
        projectId,
        {
          target_environment:
            typeof bodyObj.target_environment === 'string'
              ? (bodyObj.target_environment as ExecutionEnvironment)
              : undefined,
          notes: typeof bodyObj.notes === 'string' ? bodyObj.notes : undefined,
          approval_id:
            typeof bodyObj.approval_id === 'string' ? bodyObj.approval_id : undefined,
        },
        {
          actor: req.tejauraSession!.toPolicyActor(),
          correlation_id: req.tejauraCorrelationId ?? 'corr_proj_deploy',
        },
      );
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, ...outcome.data });
    },
  );

  app.delete(
    '/api/projects/:id',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const projectId = sanitizeString(req.params.id, 2, 128);
      if (!projectId) {
        res.status(400).json({ ok: false, code: 'INVALID_PROJECT_ID', error: 'Invalid project ID.' });
        return;
      }
      const outcome = management.deleteProject(projectId, {
        actor: req.tejauraSession!.toPolicyActor(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_proj_delete',
      });
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, ...outcome.data });
    },
  );

  app.get(
    '/api/system/admin',
    requireOwnerAuth('governance:read'),
    (_req: Request, res: Response) => {
      res.json({
        ok: true,
        admin: management.getSystemAdminOverview(),
      });
    },
  );

  app.patch(
    '/api/system/config',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      if (!isPlainObject(req.body)) {
        res.status(400).json({ ok: false, code: 'INVALID_BODY', error: 'System configuration payload must be a JSON object.' });
        return;
      }
      const outcome = management.updateRuntimeSystemConfig(req.body, {
        actor: req.tejauraSession!.toPolicyActor(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_sys_cfg',
      });
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, config: outcome.data });
    },
  );

  app.get(
    '/api/system/logs',
    requireOwnerAuth('audit:read'),
    (req: Request, res: Response) => {
      const source =
        req.query.source === 'audit' ||
        req.query.source === 'task_event' ||
        req.query.source === 'agent_execution'
          ? req.query.source
          : 'all';
      const severity =
        req.query.severity === 'info' ||
        req.query.severity === 'warn' ||
        req.query.severity === 'error'
          ? req.query.severity
          : 'all';
      const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 40;
      const rawOffset = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
      const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.round(rawLimit))) : 40;
      const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.round(rawOffset)) : 0;
      const logs = management.querySystemLogs({ source, severity, limit, offset });
      res.json({
        ok: true,
        logs: logs.items,
        total: logs.total,
        limit,
        offset,
      });
    },
  );

  app.get(
    '/api/system/backups',
    requireOwnerAuth('governance:read'),
    (_req: Request, res: Response) => {
      res.json({
        ok: true,
        backups: store.listSystemBackups(25),
      });
    },
  );

  app.post(
    '/api/system/backups',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const outcome = management.createSystemBackup({
        actor: req.tejauraSession!.toPolicyActor(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_backup_create',
      });
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.status(201).json({ ok: true, backup: outcome.data });
    },
  );

  app.post(
    '/api/system/backups/:id/restore',
    requireOwnerAuth('governance:write'),
    (req: AuthedRequest, res: Response) => {
      const backupId = sanitizeString(req.params.id, 3, 128);
      if (!backupId) {
        res.status(400).json({ ok: false, code: 'INVALID_BACKUP_ID', error: 'Invalid backup ID.' });
        return;
      }
      const outcome = management.restoreSystemBackup(backupId, {
        actor: req.tejauraSession!.toPolicyActor(),
        correlation_id: req.tejauraCorrelationId ?? 'corr_backup_restore',
      });
      if (!outcome.ok) {
        res.status(outcome.http_status).json({ ok: false, code: outcome.code, error: outcome.error });
        return;
      }
      res.json({ ok: true, backup: outcome.data });
    },
  );

  // Any unmatched /api route fails closed with JSON 404.
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({
      ok: false,
      code: 'API_ROUTE_NOT_FOUND',
      error: 'Control plane API endpoint not found.',
    });
  });

  return {
    app,
    store,
    auth,
    secretsManager,
    auditLogger,
    registry,
    hardware,
    runtime,
    lifecycle,
    router,
    orchestrator,
    executionEngine,
    management,
    close: () => {
      orchestrator.stopWorkerLoop();
      store.close();
    },
  };
}
