import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AuditLogger } from '../audit/index.ts';
import {
  authorizeRbac,
  principalToPolicyActor,
  principalToTrustedReviewerContext,
} from '../rbac/index.ts';
import type { RbacPrincipal } from '../rbac/index.ts';
import type { SecretsManager } from '../secrets/index.ts';
import {
  constantTimeEqualStrings,
  decryptAes256Gcm,
  deriveAes256Key,
  encryptAes256Gcm,
  enforceHttpsTransport,
  generateOpaqueToken,
  hashSecretArgon2id,
  validateIdentityStoreSnapshot,
  validatePasswordStrength,
  validateSecurityConfig,
  verifySecretArgon2id,
} from '../security/index.ts';
import type {
  EncryptedEnvelope,
  IdentityStoreSnapshot,
  SecurityConfig,
  StoredOwnerAccount,
  StoredPasskeyCredential,
  StoredRecoveryCode,
} from '../security/index.ts';
import type {
  ActiveSessionSummary,
  AuthFailureResult,
  AuthRequestContext,
  AuthenticatedSessionContext,
  IdentityStoreBackend,
  InitialOwnerSetupInput,
  InitialOwnerSetupResult,
  LoginInput,
  LoginSuccessResult,
  MfaEnrollmentResult,
  MfaFactorSummary,
  OwnerProfileSummary,
  PasskeyAssertionPayload,
  RecoverAccountInput,
  SessionTransportMode,
} from './auth-types.ts';
import {
  MfaModuleRegistry,
  PasskeyModuleRegistry,
  createEncryptedTotpFactor,
} from './mfa-passkey.ts';
import { LoginRateLimiter } from './rate-limiter.ts';
import {
  SessionManager,
  buildClearSessionCookieHeader,
  parseSessionTokenFromCookieHeader,
  resolveSessionTransportMode,
} from './session-manager.ts';

const FORBIDDEN_PUBLIC_DIR_NAMES = new Set([
  'public',
  'dist',
  'build',
  'src',
  'static',
  'www',
]);

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OWNER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,63}$/;

// Dummy hash generated once per process start to equalize timing when identifier does not match.
const DUMMY_ARGON2ID_HASH_PROMISE = crypto.randomBytes(16);

export class InMemoryIdentityStoreBackend implements IdentityStoreBackend {
  private snapshot: IdentityStoreSnapshot = {
    schemaVersion: '1.0.0',
    owner: null,
    sessions: [],
    roleAssignments: {},
  };

  load(): IdentityStoreSnapshot {
    return JSON.parse(JSON.stringify(this.snapshot)) as IdentityStoreSnapshot;
  }

  save(snapshot: IdentityStoreSnapshot): void {
    const check = validateIdentityStoreSnapshot(snapshot);
    if (!check.valid) {
      throw new Error(
        `Refusing to save invalid identity store snapshot: ${check.errors.map((e) => e.message).join('; ')}`,
      );
    }
    this.snapshot = JSON.parse(JSON.stringify(check.data)) as IdentityStoreSnapshot;
  }
}

export class EncryptedFileIdentityStoreBackend implements IdentityStoreBackend {
  private readonly resolvedDir: string;
  private readonly resolvedFilePath: string;
  private readonly encryptionKey: Buffer;

  constructor(options: {
    stateDir: string;
    masterKeyMaterial: Buffer | string;
    fileName?: string;
  }) {
    const fileName = options.fileName ?? 'identity.enc.json';
    if (!options.stateDir || options.stateDir.trim().length === 0) {
      throw new Error('Identity store stateDir must be non-empty.');
    }
    if (
      fileName.includes('\0') ||
      fileName.includes('..') ||
      path.basename(fileName) !== fileName
    ) {
      throw new Error('Identity store file name must be a plain filename.');
    }

    const resolvedDir = path.resolve(options.stateDir);
    const segments = resolvedDir
      .split(path.sep)
      .map((s) => s.toLowerCase())
      .filter(Boolean);
    if (
      segments.some((s) => FORBIDDEN_PUBLIC_DIR_NAMES.has(s)) ||
      fs.existsSync(path.join(resolvedDir, 'index.html'))
    ) {
      throw new Error(
        'Refusing to persist identity store inside a public or web-served directory.',
      );
    }

    this.resolvedDir = resolvedDir;
    this.resolvedFilePath = path.resolve(resolvedDir, fileName);
    this.encryptionKey = deriveAes256Key(
      options.masterKeyMaterial,
      'tejaura-identity-store-v1',
    );
  }

  load(): IdentityStoreSnapshot {
    if (!fs.existsSync(this.resolvedFilePath)) {
      return {
        schemaVersion: '1.0.0',
        owner: null,
        sessions: [],
        roleAssignments: {},
      };
    }

    const stat = fs.lstatSync(this.resolvedFilePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Identity store file must not be a symlink.');
    }

    const raw = fs.readFileSync(this.resolvedFilePath, 'utf8');
    const envelope = JSON.parse(raw) as EncryptedEnvelope;
    const decryptedJson = decryptAes256Gcm(
      envelope,
      this.encryptionKey,
      'tejaura:identity-store:v1',
    );
    const parsed = JSON.parse(decryptedJson) as unknown;
    const check = validateIdentityStoreSnapshot(parsed);
    if (!check.valid) {
      throw new Error(
        `Loaded identity snapshot failed schema validation: ${check.errors.map((e) => e.message).join('; ')}`,
      );
    }
    return check.data;
  }

  save(snapshot: IdentityStoreSnapshot): void {
    const check = validateIdentityStoreSnapshot(snapshot);
    if (!check.valid) {
      throw new Error(
        `Refusing to persist invalid identity store snapshot: ${check.errors.map((e) => e.message).join('; ')}`,
      );
    }

    fs.mkdirSync(this.resolvedDir, { recursive: true, mode: 0o700 });
    const envelope = encryptAes256Gcm(
      JSON.stringify(check.data),
      this.encryptionKey,
      'tejaura:identity-store:v1',
      'identity-v1',
    );
    const tmpPath = `${this.resolvedFilePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(tmpPath, this.resolvedFilePath);
    fs.chmodSync(this.resolvedFilePath, 0o600);
  }
}

export interface TejauraAuthServiceOptions {
  securityConfig: SecurityConfig;
  masterKeyMaterial: Buffer | string;
  store?: IdentityStoreBackend;
  secretsManager?: SecretsManager;
  auditLogger?: AuditLogger;
  mfaRegistry?: MfaModuleRegistry;
  passkeyRegistry?: PasskeyModuleRegistry;
  clock?: () => Date;
}

export class TejauraAuthService {
  private readonly config: SecurityConfig;
  private readonly masterKey: Buffer;
  private readonly store: IdentityStoreBackend;
  private readonly secretsManager?: SecretsManager;
  private readonly auditLogger?: AuditLogger;
  private readonly mfaRegistry: MfaModuleRegistry;
  private readonly passkeyRegistry: PasskeyModuleRegistry;
  private readonly rateLimiter: LoginRateLimiter;
  private readonly sessionManager: SessionManager;
  private readonly clock: () => Date;
  private readonly pendingPasskeyChallenges = new Map<
    string,
    { challenge: string; expiresAtMs: number; ownerId: string }
  >();
  private dummyHashCache: string | null = null;

  constructor(options: TejauraAuthServiceOptions) {
    const configCheck = validateSecurityConfig(options.securityConfig);
    if (!configCheck.valid) {
      throw new Error(
        `Invalid Stage 2B SecurityConfig: ${configCheck.errors.map((e) => e.message).join('; ')}`,
      );
    }

    this.config = configCheck.data;
    this.masterKey = deriveAes256Key(
      options.masterKeyMaterial,
      'tejaura-auth-master-v1',
    );
    this.store = options.store ?? new InMemoryIdentityStoreBackend();
    this.secretsManager = options.secretsManager;
    this.auditLogger = options.auditLogger;
    this.clock = options.clock ?? (() => new Date());
    this.mfaRegistry = options.mfaRegistry ?? new MfaModuleRegistry();
    this.passkeyRegistry = options.passkeyRegistry ?? new PasskeyModuleRegistry();
    this.rateLimiter = new LoginRateLimiter(this.config.rateLimit, this.clock);
    this.sessionManager = new SessionManager({
      policy: this.config.session,
      encryptionKey: this.masterKey,
      clock: this.clock,
    });
  }

  getSecurityConfig(): SecurityConfig {
    return this.config;
  }

  isOwnerInitialized(): boolean {
    const snapshot = this.store.load();
    return snapshot.owner !== null;
  }

  private async getDummyHash(): Promise<string> {
    if (!this.dummyHashCache) {
      const dummySecret = DUMMY_ARGON2ID_HASH_PROMISE.toString('hex');
      this.dummyHashCache = await hashSecretArgon2id(
        dummySecret,
        this.config.argon2id,
      );
    }
    return this.dummyHashCache;
  }

  private resolveTransport(request?: AuthRequestContext):
    | { ok: true; protocol: 'https' | 'http-loopback-dev'; mode: SessionTransportMode }
    | { ok: false; failure: AuthFailureResult } {
    if (!request) {
      return { ok: true, protocol: 'https', mode: 'https_direct' };
    }
    const res = enforceHttpsTransport(request, this.config.transport);
    if (!res.allowed) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: res.code,
          error: res.error,
        },
      };
    }
    return {
      ok: true,
      protocol: res.protocol,
      mode: resolveSessionTransportMode({
        protocol: res.protocol,
        secFetchSite: request.secFetchSite,
        secFetchDest: request.secFetchDest,
      }),
    };
  }

  private checkTransport(request?: AuthRequestContext): AuthFailureResult | null {
    const resolved = this.resolveTransport(request);
    return resolved.ok ? null : resolved.failure;
  }

  private buildAuthenticatedContext(
    owner: StoredOwnerAccount,
    sessionExpiresAt: string,
    sessionIdleExpiresAt: string,
    sessionId: string,
  ): AuthenticatedSessionContext {
    const toPrincipal = (): RbacPrincipal => ({
      actor_id: owner.owner_id,
      actor_type: 'owner',
      role: 'owner',
      authenticated: true,
      auth_source: 'tejaura-owner-session',
      session_id: sessionId,
    });

    return {
      session_id: sessionId,
      owner_id: owner.owner_id,
      username: owner.username,
      role: 'owner',
      expires_at: sessionExpiresAt,
      idle_expires_at: sessionIdleExpiresAt,
      toPrincipal,
      toPolicyActor: () => principalToPolicyActor(toPrincipal()),
      toTrustedReviewerContext: () =>
        principalToTrustedReviewerContext(toPrincipal()),
    };
  }

  private async generateRecoveryCodes(): Promise<{
    plaintextCodes: string[];
    hashedRecords: StoredRecoveryCode[];
  }> {
    const plaintextCodes: string[] = [];
    const hashedRecords: StoredRecoveryCode[] = [];

    for (let i = 0; i < this.config.recovery.codeCount; i += 1) {
      const raw = crypto.randomBytes(10).toString('hex').toUpperCase();
      const formatted = `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
      const codeHash = await hashSecretArgon2id(
        formatted,
        this.config.argon2id,
      );
      plaintextCodes.push(formatted);
      hashedRecords.push({
        code_id: `rec_${crypto.randomUUID().slice(0, 8)}`,
        code_hash: codeHash,
        used_at: null,
      });
    }

    return { plaintextCodes, hashedRecords };
  }

  private auditAuth(params: {
    actor_type: 'owner' | 'system';
    actor_id: string;
    event_type: Parameters<AuditLogger['logAuthEvent']>[0]['event_type'];
    resource_id: string;
    action: string;
    outcome: 'success' | 'failure' | 'denied';
    correlation_id: string;
    metadata?: Record<string, unknown>;
  }): boolean {
    if (!this.auditLogger) return true;
    const res = this.auditLogger.logAuthEvent(params);
    return res.ok;
  }

  async setupInitialOwner(
    input: InitialOwnerSetupInput,
  ): Promise<InitialOwnerSetupResult | AuthFailureResult> {
    const transportFailure = this.checkTransport(input.request);
    if (transportFailure) return transportFailure;

    const snapshot = this.store.load();
    if (snapshot.owner !== null) {
      return {
        ok: false,
        code: 'OWNER_ALREADY_INITIALIZED',
        error: 'Initial owner account has already been set up.',
      };
    }

    const ownerId = (input.owner_id ?? '').trim();
    const username = (input.username ?? '').trim().toLowerCase();
    const email = (input.email ?? '').trim().toLowerCase();

    if (
      !OWNER_ID_PATTERN.test(ownerId) ||
      /^agent([_.:-]|$)/i.test(ownerId)
    ) {
      return {
        ok: false,
        code: 'INVALID_OWNER_ID',
        error: 'Owner ID must be a valid non-agent identifier.',
      };
    }

    if (!USERNAME_PATTERN.test(username)) {
      return {
        ok: false,
        code: 'INVALID_USERNAME',
        error:
          'Username must be 3-32 lowercase alphanumeric, dot, underscore, or hyphen characters.',
      };
    }

    if (!EMAIL_PATTERN.test(email)) {
      return {
        ok: false,
        code: 'INVALID_EMAIL',
        error: 'A valid owner email address is required.',
      };
    }

    const strength = validatePasswordStrength(
      input.password,
      this.config.passwordPolicy,
    );
    if (!strength.valid) {
      return { ok: false, code: strength.code, error: strength.error };
    }

    if (this.secretsManager) {
      const distinctCheck =
        this.secretsManager.assertPasswordDistinctFromWorkerToken(
          input.password,
        );
      if (!distinctCheck.ok) {
        return {
          ok: false,
          code: distinctCheck.code,
          error: distinctCheck.error,
        };
      }
    }

    const passwordHash = await hashSecretArgon2id(
      input.password,
      this.config.argon2id,
    );
    const { plaintextCodes, hashedRecords } = await this.generateRecoveryCodes();
    const nowIso = this.clock().toISOString();

    const displayName =
      typeof input.display_name === 'string' && input.display_name.trim().length > 0
        ? input.display_name.trim().slice(0, 100)
        : username;
    const timezone =
      typeof input.timezone === 'string' && input.timezone.trim().length > 0
        ? input.timezone.trim().slice(0, 64)
        : 'UTC';

    const ownerRecord: StoredOwnerAccount = {
      owner_id: ownerId,
      username,
      email,
      display_name: displayName,
      timezone,
      password_hash: passwordHash,
      role: 'owner',
      created_at: nowIso,
      updated_at: nowIso,
      mfa_factors: [],
      passkeys: [],
      recovery_codes: hashedRecords,
    };

    const nextSnapshot: IdentityStoreSnapshot = {
      schemaVersion: '1.0.0',
      owner: ownerRecord,
      sessions: [],
      roleAssignments: {
        ...snapshot.roleAssignments,
        [ownerId]: 'owner',
      },
    };

    const auditOk =
      this.auditAuth({
        actor_type: 'owner',
        actor_id: ownerId,
        event_type: 'auth.setup.completed',
        resource_id: `owner:${ownerId}`,
        action: 'auth:setup_owner',
        outcome: 'success',
        correlation_id: input.correlation_id,
        metadata: { username },
      }) &&
      this.auditAuth({
        actor_type: 'owner',
        actor_id: ownerId,
        event_type: 'auth.recovery.generated',
        resource_id: `owner:${ownerId}`,
        action: 'auth:generate_recovery_codes',
        outcome: 'success',
        correlation_id: input.correlation_id,
        metadata: { code_count: plaintextCodes.length },
      });

    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Owner setup aborted because security audit logging failed.',
      };
    }

    this.store.save(nextSnapshot);

    return {
      ok: true,
      owner_id: ownerId,
      username,
      recovery_codes: plaintextCodes,
    };
  }

  async login(
    input: LoginInput,
  ): Promise<LoginSuccessResult | AuthFailureResult> {
    const transportFailure = this.checkTransport(input.request);
    if (transportFailure) return transportFailure;

    const identifier = (input.identifier ?? '').trim().toLowerCase();
    const clientIp = input.request?.clientIp;

    const rateCheck = this.rateLimiter.check(identifier, clientIp);
    if (!rateCheck.allowed) {
      this.auditAuth({
        actor_type: 'system',
        actor_id: 'tejaura_auth',
        event_type: 'auth.login.failed',
        resource_id: 'owner:login',
        action: 'auth:login',
        outcome: 'denied',
        correlation_id: input.correlation_id,
        metadata: { reason_code: 'RATE_LIMITED', client_ip: clientIp ?? null },
      });
      return {
        ok: false,
        code: rateCheck.code,
        error: rateCheck.error,
        retry_after_seconds: rateCheck.retryAfterSeconds,
      };
    }

    const snapshot = this.store.load();
    const owner = snapshot.owner;

    const identifierMatches =
      owner !== null &&
      identifier.length > 0 &&
      (constantTimeEqualStrings(identifier, owner.username) ||
        constantTimeEqualStrings(identifier, owner.email));

    if (!owner || !identifierMatches) {
      // Mitigate timing side-channel user enumeration with dummy Argon2id check.
      await verifySecretArgon2id(
        input.password || 'invalid-placeholder',
        await this.getDummyHash(),
      );
      const limitAfter = this.rateLimiter.recordFailure(identifier, clientIp);
      this.auditAuth({
        actor_type: 'system',
        actor_id: 'tejaura_auth',
        event_type: 'auth.login.failed',
        resource_id: 'owner:login',
        action: 'auth:login',
        outcome: 'failure',
        correlation_id: input.correlation_id,
        metadata: { reason_code: 'INVALID_CREDENTIALS' },
      });
      if (!limitAfter.allowed) {
        return {
          ok: false,
          code: limitAfter.code,
          error: limitAfter.error,
          retry_after_seconds: limitAfter.retryAfterSeconds,
        };
      }
      return {
        ok: false,
        code: 'INVALID_CREDENTIALS',
        error: 'Invalid credentials.',
      };
    }

    const passwordValid = await verifySecretArgon2id(
      input.password,
      owner.password_hash,
    );
    if (!passwordValid) {
      const limitAfter = this.rateLimiter.recordFailure(identifier, clientIp);
      this.auditAuth({
        actor_type: 'owner',
        actor_id: owner.owner_id,
        event_type: 'auth.login.failed',
        resource_id: `owner:${owner.owner_id}`,
        action: 'auth:login',
        outcome: 'failure',
        correlation_id: input.correlation_id,
        metadata: { reason_code: 'INVALID_CREDENTIALS' },
      });
      if (!limitAfter.allowed) {
        return {
          ok: false,
          code: limitAfter.code,
          error: limitAfter.error,
          retry_after_seconds: limitAfter.retryAfterSeconds,
        };
      }
      return {
        ok: false,
        code: 'INVALID_CREDENTIALS',
        error: 'Invalid credentials.',
      };
    }

    // Check enrolled MFA factors if any are active.
    let updatedOwner = owner;
    const activeMfaFactors = owner.mfa_factors.filter((f) => f.enabled);
    if (activeMfaFactors.length > 0 && this.config.mfa.requireMfaWhenEnrolled) {
      if (!input.mfa_code || input.mfa_code.trim().length === 0) {
        this.auditAuth({
          actor_type: 'owner',
          actor_id: owner.owner_id,
          event_type: 'auth.mfa.failed',
          resource_id: `owner:${owner.owner_id}`,
          action: 'auth:mfa_verify',
          outcome: 'denied',
          correlation_id: input.correlation_id,
          metadata: { reason_code: 'MFA_CODE_REQUIRED' },
        });
        return {
          ok: false,
          code: 'MFA_CODE_REQUIRED',
          error: 'Multi-factor verification code is required.',
          mfa_required: true,
        };
      }

      const factor = input.mfa_factor_id
        ? activeMfaFactors.find((f) => f.factor_id === input.mfa_factor_id)
        : activeMfaFactors[0];

      if (!factor) {
        this.rateLimiter.recordFailure(identifier, clientIp);
        return {
          ok: false,
          code: 'MFA_FACTOR_NOT_FOUND',
          error: 'Requested MFA factor was not found.',
          mfa_required: true,
        };
      }

      const module = this.mfaRegistry.get(factor.type);
      if (!module) {
        return {
          ok: false,
          code: 'MFA_MODULE_UNAVAILABLE',
          error: `MFA module "${factor.type}" is not registered.`,
        };
      }

      const mfaResult = await module.verifyChallenge({
        factor,
        code: input.mfa_code,
        now: this.clock(),
        masterKey: this.masterKey,
      });

      if (!mfaResult.valid) {
        const limitAfter = this.rateLimiter.recordFailure(identifier, clientIp);
        this.auditAuth({
          actor_type: 'owner',
          actor_id: owner.owner_id,
          event_type: 'auth.mfa.failed',
          resource_id: `owner:${owner.owner_id}`,
          action: 'auth:mfa_verify',
          outcome: 'failure',
          correlation_id: input.correlation_id,
          metadata: { reason_code: mfaResult.code, factor_id: factor.factor_id },
        });
        if (!limitAfter.allowed) {
          return {
            ok: false,
            code: limitAfter.code,
            error: limitAfter.error,
            retry_after_seconds: limitAfter.retryAfterSeconds,
          };
        }
        return {
          ok: false,
          code: mfaResult.code,
          error: mfaResult.error,
          mfa_required: true,
        };
      }

      if (mfaResult.next_used_step !== undefined) {
        updatedOwner = {
          ...owner,
          updated_at: this.clock().toISOString(),
          mfa_factors: owner.mfa_factors.map((f) =>
            f.factor_id === factor.factor_id
              ? { ...f, last_used_step: mfaResult.next_used_step! }
              : f,
          ),
        };
      }

      this.auditAuth({
        actor_type: 'owner',
        actor_id: owner.owner_id,
        event_type: 'auth.mfa.verified',
        resource_id: `owner:${owner.owner_id}`,
        action: 'auth:mfa_verify',
        outcome: 'success',
        correlation_id: input.correlation_id,
        metadata: { factor_id: factor.factor_id, type: factor.type },
      });
    }

    this.rateLimiter.reset(identifier, clientIp);

    const resolvedTransport = this.resolveTransport(input.request);
    const transportMode = resolvedTransport.ok ? resolvedTransport.mode : 'https_direct';

    const { issued, updatedSessions } = this.sessionManager.createSession({
      actorId: owner.owner_id,
      role: 'owner',
      existingSessions: snapshot.sessions,
      transportMode,
      metadata: {
        client_ip: clientIp,
        user_agent: input.request?.userAgent,
      },
    });

    const auditOk = this.auditAuth({
      actor_type: 'owner',
      actor_id: owner.owner_id,
      event_type: 'auth.login.succeeded',
      resource_id: `session:${issued.record.session_id}`,
      action: 'auth:login',
      outcome: 'success',
      correlation_id: input.correlation_id,
      metadata: {
        session_id: issued.record.session_id,
        transport_mode: issued.transportMode,
      },
    });
    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Login aborted because security audit logging failed.',
      };
    }

    this.store.save({
      ...snapshot,
      owner: updatedOwner,
      sessions: updatedSessions,
    });

    return {
      ok: true,
      session: this.buildAuthenticatedContext(
        updatedOwner,
        issued.record.expires_at,
        issued.record.idle_expires_at,
        issued.record.session_id,
      ),
      set_cookie_header: issued.setCookieHeader,
      transport_mode: issued.transportMode,
    };
  }

  issuePasskeyChallenge(params: {
    correlation_id: string;
    request?: AuthRequestContext;
  }): { ok: true; challenge: string; expires_at: string } | AuthFailureResult {
    const transportFailure = this.checkTransport(params.request);
    if (transportFailure) return transportFailure;

    if (!this.config.mfa.allowPasskeyModule) {
      return {
        ok: false,
        code: 'PASSKEY_MODULE_DISABLED',
        error: 'Passkey authentication is disabled by security configuration.',
      };
    }

    const snapshot = this.store.load();
    if (!snapshot.owner || snapshot.owner.passkeys.length === 0) {
      return {
        ok: false,
        code: 'NO_PASSKEY_REGISTERED',
        error: 'No passkeys are registered for the owner account.',
      };
    }

    const challenge = generateOpaqueToken(32);
    const expiresAtMs = this.clock().getTime() + 120_000;
    this.pendingPasskeyChallenges.set(challenge, {
      challenge,
      expiresAtMs,
      ownerId: snapshot.owner.owner_id,
    });

    return {
      ok: true,
      challenge,
      expires_at: new Date(expiresAtMs).toISOString(),
    };
  }

  async authenticatePasskey(params: {
    assertion: PasskeyAssertionPayload;
    expectedOrigin: string;
    correlation_id: string;
    request?: AuthRequestContext;
  }): Promise<LoginSuccessResult | AuthFailureResult> {
    const transportFailure = this.checkTransport(params.request);
    if (transportFailure) return transportFailure;

    const clientIp = params.request?.clientIp;
    const rateCheck = this.rateLimiter.check('passkey-owner', clientIp);
    if (!rateCheck.allowed) {
      return {
        ok: false,
        code: rateCheck.code,
        error: rateCheck.error,
        retry_after_seconds: rateCheck.retryAfterSeconds,
      };
    }

    const challengeRecord = this.pendingPasskeyChallenges.get(
      params.assertion.challenge,
    );
    // Single-use challenge consumption
    this.pendingPasskeyChallenges.delete(params.assertion.challenge);

    if (!challengeRecord || challengeRecord.expiresAtMs <= this.clock().getTime()) {
      this.rateLimiter.recordFailure('passkey-owner', clientIp);
      return {
        ok: false,
        code: 'PASSKEY_CHALLENGE_INVALID_OR_EXPIRED',
        error: 'Passkey challenge is missing, already consumed, or expired.',
      };
    }

    const snapshot = this.store.load();
    const owner = snapshot.owner;
    if (!owner || owner.owner_id !== challengeRecord.ownerId) {
      return {
        ok: false,
        code: 'OWNER_NOT_INITIALIZED',
        error: 'Owner account is not initialized.',
      };
    }

    const credential = owner.passkeys.find(
      (p) => p.credential_id === params.assertion.credential_id,
    );
    if (!credential) {
      this.rateLimiter.recordFailure('passkey-owner', clientIp);
      this.auditAuth({
        actor_type: 'owner',
        actor_id: owner.owner_id,
        event_type: 'auth.passkey.failed',
        resource_id: `owner:${owner.owner_id}`,
        action: 'auth:passkey_login',
        outcome: 'failure',
        correlation_id: params.correlation_id,
        metadata: { reason_code: 'UNKNOWN_CREDENTIAL_ID' },
      });
      return {
        ok: false,
        code: 'UNKNOWN_PASSKEY_CREDENTIAL',
        error: 'Passkey credential is not registered.',
      };
    }

    const verifier = this.passkeyRegistry.get(credential.algorithm);
    if (!verifier) {
      return {
        ok: false,
        code: 'PASSKEY_VERIFIER_UNAVAILABLE',
        error: `No passkey verifier registered for "${credential.algorithm}".`,
      };
    }

    const verification = await verifier.verifyAssertion({
      credential,
      assertion: params.assertion,
      expectedOrigin: params.expectedOrigin,
    });

    if (!verification.valid) {
      this.rateLimiter.recordFailure('passkey-owner', clientIp);
      this.auditAuth({
        actor_type: 'owner',
        actor_id: owner.owner_id,
        event_type: 'auth.passkey.failed',
        resource_id: `owner:${owner.owner_id}`,
        action: 'auth:passkey_login',
        outcome: 'failure',
        correlation_id: params.correlation_id,
        metadata: { reason_code: verification.code },
      });
      return {
        ok: false,
        code: verification.code,
        error: verification.error,
      };
    }

    this.rateLimiter.reset('passkey-owner', clientIp);
    const nowIso = this.clock().toISOString();
    const updatedOwner: StoredOwnerAccount = {
      ...owner,
      updated_at: nowIso,
      passkeys: owner.passkeys.map((p) =>
        p.credential_id === credential.credential_id
          ? {
              ...p,
              sign_count: verification.new_sign_count,
              last_used_at: nowIso,
            }
          : p,
      ),
    };

    const resolvedTransport = this.resolveTransport(params.request);
    const transportMode = resolvedTransport.ok ? resolvedTransport.mode : 'https_direct';

    const { issued, updatedSessions } = this.sessionManager.createSession({
      actorId: owner.owner_id,
      role: 'owner',
      existingSessions: snapshot.sessions,
      transportMode,
      metadata: {
        client_ip: clientIp,
        user_agent: params.request?.userAgent,
      },
    });

    const auditOk = this.auditAuth({
      actor_type: 'owner',
      actor_id: owner.owner_id,
      event_type: 'auth.passkey.verified',
      resource_id: `session:${issued.record.session_id}`,
      action: 'auth:passkey_login',
      outcome: 'success',
      correlation_id: params.correlation_id,
      metadata: {
        credential_id: credential.credential_id,
        session_id: issued.record.session_id,
        transport_mode: issued.transportMode,
      },
    });
    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Passkey login aborted because security audit logging failed.',
      };
    }

    this.store.save({
      ...snapshot,
      owner: updatedOwner,
      sessions: updatedSessions,
    });

    return {
      ok: true,
      session: this.buildAuthenticatedContext(
        updatedOwner,
        issued.record.expires_at,
        issued.record.idle_expires_at,
        issued.record.session_id,
      ),
      set_cookie_header: issued.setCookieHeader,
      transport_mode: issued.transportMode,
    };
  }

  authenticateSessionFromCookieHeader(
    cookieHeader: string | undefined,
    request?: AuthRequestContext,
  ):
    | { ok: true; session: AuthenticatedSessionContext }
    | AuthFailureResult {
    const resolvedTransport = this.resolveTransport(request);
    if (!resolvedTransport.ok) return resolvedTransport.failure;

    const allowDevLoopbackFallback =
      resolvedTransport.protocol === 'http-loopback-dev';

    const rawToken = parseSessionTokenFromCookieHeader(
      cookieHeader,
      this.config.session.cookieName,
      allowDevLoopbackFallback,
    );
    if (!rawToken) {
      return {
        ok: false,
        code: 'MISSING_SESSION_COOKIE',
        error: 'Authenticated session cookie is required.',
      };
    }

    const snapshot = this.store.load();
    if (!snapshot.owner) {
      return {
        ok: false,
        code: 'OWNER_NOT_INITIALIZED',
        error: 'Owner account is not initialized.',
      };
    }

    const verified = this.sessionManager.verifyAndTouchSession({
      rawToken,
      sessions: snapshot.sessions,
    });
    if (!verified.valid) {
      return {
        ok: false,
        code: verified.code,
        error: verified.error,
      };
    }

    if (verified.record.actor_id !== snapshot.owner.owner_id) {
      return {
        ok: false,
        code: 'SESSION_OWNER_MISMATCH',
        error: 'Session does not belong to the initialized owner.',
      };
    }

    this.store.save({
      ...snapshot,
      sessions: verified.updatedSessions,
    });

    return {
      ok: true,
      session: this.buildAuthenticatedContext(
        snapshot.owner,
        verified.record.expires_at,
        verified.record.idle_expires_at,
        verified.record.session_id,
      ),
    };
  }

  logout(params: {
    cookieHeader: string | undefined;
    correlation_id: string;
    request?: AuthRequestContext;
  }): { ok: true; clear_cookie_header: string; clear_cookie_headers: string[] } {
    const resolvedTransport = this.resolveTransport(params.request);
    const transportMode = resolvedTransport.ok ? resolvedTransport.mode : 'https_direct';
    const allowDevFallback =
      resolvedTransport.ok && resolvedTransport.protocol === 'http-loopback-dev';

    const rawToken = parseSessionTokenFromCookieHeader(
      params.cookieHeader,
      this.config.session.cookieName,
      allowDevFallback || !params.request,
    );
    const primaryClearHeader = buildClearSessionCookieHeader(
      this.config.session,
      transportMode,
    );
    const clearHeaders = [primaryClearHeader];
    if (allowDevFallback) {
      clearHeaders.push(buildClearSessionCookieHeader(this.config.session, 'https_direct'));
    }

    if (!rawToken) {
      return {
        ok: true,
        clear_cookie_header: primaryClearHeader,
        clear_cookie_headers: clearHeaders,
      };
    }

    const snapshot = this.store.load();
    const { revokedSessionId, actorId, updatedSessions } =
      this.sessionManager.revokeByToken(
        rawToken,
        snapshot.sessions,
        'owner_logout',
      );

    if (revokedSessionId && actorId) {
      this.store.save({
        ...snapshot,
        sessions: updatedSessions,
      });
      this.auditAuth({
        actor_type: 'owner',
        actor_id: actorId,
        event_type: 'auth.logout',
        resource_id: `session:${revokedSessionId}`,
        action: 'auth:logout',
        outcome: 'success',
        correlation_id: params.correlation_id,
        metadata: { session_id: revokedSessionId },
      });
    }

    return {
      ok: true,
      clear_cookie_header: primaryClearHeader,
      clear_cookie_headers: clearHeaders,
    };
  }

  revokeSession(params: {
    principal: RbacPrincipal;
    target_session_id: string;
    correlation_id: string;
  }): { ok: true } | AuthFailureResult {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'auth:admin',
      resource_id: params.target_session_id,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const snapshot = this.store.load();
    const { revoked, updatedSessions } = this.sessionManager.revokeBySessionId(
      params.target_session_id,
      snapshot.sessions,
      'owner_revoked',
    );
    if (!revoked) {
      return {
        ok: false,
        code: 'SESSION_NOT_FOUND_OR_REVOKED',
        error: 'Target active session was not found.',
      };
    }

    const auditOk = this.auditAuth({
      actor_type: 'owner',
      actor_id: params.principal.actor_id,
      event_type: 'auth.session.revoked',
      resource_id: `session:${params.target_session_id}`,
      action: 'auth:revoke_session',
      outcome: 'success',
      correlation_id: params.correlation_id,
      metadata: { target_session_id: params.target_session_id },
    });
    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Session revocation aborted because audit logging failed.',
      };
    }

    this.store.save({
      ...snapshot,
      sessions: updatedSessions,
    });
    return { ok: true };
  }

  revokeAllSessions(params: {
    principal: RbacPrincipal;
    correlation_id: string;
  }): { ok: true; revoked_count: number; clear_cookie_header: string } | AuthFailureResult {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'auth:admin',
      resource_id: `owner:${params.principal.actor_id}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const snapshot = this.store.load();
    const { revokedCount, updatedSessions } =
      this.sessionManager.revokeAllForActor(
        params.principal.actor_id,
        snapshot.sessions,
        'owner_revoked_all',
      );

    const auditOk = this.auditAuth({
      actor_type: 'owner',
      actor_id: params.principal.actor_id,
      event_type: 'auth.session.revoked',
      resource_id: `owner:${params.principal.actor_id}`,
      action: 'auth:revoke_all_sessions',
      outcome: 'success',
      correlation_id: params.correlation_id,
      metadata: { revoked_count: revokedCount },
    });
    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Bulk session revocation aborted because audit logging failed.',
      };
    }

    this.store.save({
      ...snapshot,
      sessions: updatedSessions,
    });
    return {
      ok: true,
      revoked_count: revokedCount,
      clear_cookie_header: buildClearSessionCookieHeader(this.config.session),
    };
  }

  /**
   * Secure account recovery using single-use Argon2id-hashed recovery codes.
   * Rotates password hash and revokes all active sessions without ever
   * returning existing passwords or secrets.
   */
  async recoverAccount(
    input: RecoverAccountInput,
  ): Promise<
    | { ok: true; owner_id: string; revoked_sessions: number; remaining_recovery_codes: number }
    | AuthFailureResult
  > {
    const transportFailure = this.checkTransport(input.request);
    if (transportFailure) return transportFailure;

    const identifier = (input.identifier ?? '').trim().toLowerCase();
    const clientIp = input.request?.clientIp;
    const rateKey = `recovery:${identifier}`;
    const rateCheck = this.rateLimiter.check(rateKey, clientIp);
    if (!rateCheck.allowed) {
      return {
        ok: false,
        code: rateCheck.code,
        error: rateCheck.error,
        retry_after_seconds: rateCheck.retryAfterSeconds,
      };
    }

    const snapshot = this.store.load();
    const owner = snapshot.owner;
    if (
      !owner ||
      (!constantTimeEqualStrings(identifier, owner.username) &&
        !constantTimeEqualStrings(identifier, owner.email))
    ) {
      this.rateLimiter.recordFailure(rateKey, clientIp);
      this.auditAuth({
        actor_type: 'system',
        actor_id: 'tejaura_auth',
        event_type: 'auth.recovery.failed',
        resource_id: 'owner:recovery',
        action: 'auth:recover_account',
        outcome: 'failure',
        correlation_id: input.correlation_id,
        metadata: { reason_code: 'RECOVERY_VERIFICATION_FAILED' },
      });
      return {
        ok: false,
        code: 'RECOVERY_VERIFICATION_FAILED',
        error: 'Account recovery verification failed.',
      };
    }

    const strength = validatePasswordStrength(
      input.new_password,
      this.config.passwordPolicy,
    );
    if (!strength.valid) {
      return { ok: false, code: strength.code, error: strength.error };
    }

    if (this.secretsManager) {
      const distinctCheck =
        this.secretsManager.assertPasswordDistinctFromWorkerToken(
          input.new_password,
        );
      if (!distinctCheck.ok) {
        return {
          ok: false,
          code: distinctCheck.code,
          error: distinctCheck.error,
        };
      }
    }

    const normalizedCode = (input.recovery_code ?? '').trim().toUpperCase();
    let matchedCodeId: string | null = null;
    for (const rec of owner.recovery_codes) {
      if (rec.used_at !== null) continue;
      if (await verifySecretArgon2id(normalizedCode, rec.code_hash)) {
        matchedCodeId = rec.code_id;
        break;
      }
    }

    if (!matchedCodeId) {
      const limitAfter = this.rateLimiter.recordFailure(rateKey, clientIp);
      this.auditAuth({
        actor_type: 'owner',
        actor_id: owner.owner_id,
        event_type: 'auth.recovery.failed',
        resource_id: `owner:${owner.owner_id}`,
        action: 'auth:recover_account',
        outcome: 'failure',
        correlation_id: input.correlation_id,
        metadata: { reason_code: 'RECOVERY_CODE_INVALID' },
      });
      if (!limitAfter.allowed) {
        return {
          ok: false,
          code: limitAfter.code,
          error: limitAfter.error,
          retry_after_seconds: limitAfter.retryAfterSeconds,
        };
      }
      return {
        ok: false,
        code: 'RECOVERY_VERIFICATION_FAILED',
        error: 'Account recovery verification failed.',
      };
    }

    this.rateLimiter.reset(rateKey, clientIp);
    const nowIso = this.clock().toISOString();
    const newPasswordHash = await hashSecretArgon2id(
      input.new_password,
      this.config.argon2id,
    );

    const updatedCodes = owner.recovery_codes.map((rec) =>
      rec.code_id === matchedCodeId ? { ...rec, used_at: nowIso } : rec,
    );

    const { revokedCount, updatedSessions } =
      this.sessionManager.revokeAllForActor(
        owner.owner_id,
        snapshot.sessions,
        'account_recovery_reset',
      );

    const updatedOwner: StoredOwnerAccount = {
      ...owner,
      password_hash: newPasswordHash,
      updated_at: nowIso,
      recovery_codes: updatedCodes,
    };

    const auditOk = this.auditAuth({
      actor_type: 'owner',
      actor_id: owner.owner_id,
      event_type: 'auth.recovery.succeeded',
      resource_id: `owner:${owner.owner_id}`,
      action: 'auth:recover_account',
      outcome: 'success',
      correlation_id: input.correlation_id,
      metadata: {
        used_code_id: matchedCodeId,
        revoked_sessions: revokedCount,
      },
    });
    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Recovery aborted because security audit logging failed.',
      };
    }

    this.store.save({
      ...snapshot,
      owner: updatedOwner,
      sessions: updatedSessions,
    });

    return {
      ok: true,
      owner_id: owner.owner_id,
      revoked_sessions: revokedCount,
      remaining_recovery_codes: updatedCodes.filter((c) => c.used_at === null).length,
    };
  }

  enrollTotpMfa(params: {
    principal: RbacPrincipal;
    label: string;
    correlation_id: string;
  }): MfaEnrollmentResult | AuthFailureResult {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'auth:admin',
      resource_id: `owner:${params.principal.actor_id}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    if (!this.config.mfa.allowTotpModule) {
      return {
        ok: false,
        code: 'TOTP_MODULE_DISABLED',
        error: 'TOTP MFA module is disabled by security configuration.',
      };
    }

    const snapshot = this.store.load();
    if (!snapshot.owner || snapshot.owner.owner_id !== params.principal.actor_id) {
      return {
        ok: false,
        code: 'OWNER_NOT_FOUND',
        error: 'Authenticated owner account was not found.',
      };
    }

    const factorId = `mfa_${crypto.randomUUID().slice(0, 8)}`;
    const now = this.clock();
    const { factor, secretBase32, otpauthUri } = createEncryptedTotpFactor({
      factorId,
      label: params.label.trim() || 'Owner Authenticator',
      ownerUsername: snapshot.owner.username,
      masterKey: this.masterKey,
      now,
    });

    const updatedOwner: StoredOwnerAccount = {
      ...snapshot.owner,
      updated_at: now.toISOString(),
      mfa_factors: [...snapshot.owner.mfa_factors, factor],
    };

    const auditOk = this.auditAuth({
      actor_type: 'owner',
      actor_id: snapshot.owner.owner_id,
      event_type: 'auth.mfa.enrolled',
      resource_id: `owner:${snapshot.owner.owner_id}`,
      action: 'auth:enroll_mfa',
      outcome: 'success',
      correlation_id: params.correlation_id,
      metadata: { factor_id: factorId, type: 'totp' },
    });
    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'MFA enrollment aborted because security audit logging failed.',
      };
    }

    this.store.save({
      ...snapshot,
      owner: updatedOwner,
    });

    return {
      ok: true,
      factor_id: factorId,
      type: 'totp',
      otpauth_uri: otpauthUri,
      provisioning_secret: secretBase32,
    };
  }

  registerPasskey(params: {
    principal: RbacPrincipal;
    credential_id: string;
    label: string;
    algorithm: StoredPasskeyCredential['algorithm'];
    public_key_pem: string;
    transports?: string[];
    correlation_id: string;
  }): { ok: true; credential_id: string } | AuthFailureResult {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'auth:admin',
      resource_id: `owner:${params.principal.actor_id}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    if (!this.config.mfa.allowPasskeyModule) {
      return {
        ok: false,
        code: 'PASSKEY_MODULE_DISABLED',
        error: 'Passkey module is disabled by security configuration.',
      };
    }

    const snapshot = this.store.load();
    if (!snapshot.owner || snapshot.owner.owner_id !== params.principal.actor_id) {
      return {
        ok: false,
        code: 'OWNER_NOT_FOUND',
        error: 'Authenticated owner account was not found.',
      };
    }

    if (
      snapshot.owner.passkeys.some(
        (p) => p.credential_id === params.credential_id,
      )
    ) {
      return {
        ok: false,
        code: 'PASSKEY_ALREADY_REGISTERED',
        error: 'Passkey credential ID is already registered.',
      };
    }

    const nowIso = this.clock().toISOString();
    const passkey: StoredPasskeyCredential = {
      credential_id: params.credential_id,
      label: params.label.trim() || 'Owner Passkey',
      algorithm: params.algorithm,
      public_key_pem: params.public_key_pem,
      sign_count: 0,
      registered_at: nowIso,
      last_used_at: null,
      transports: params.transports ?? ['internal'],
    };

    const updatedOwner: StoredOwnerAccount = {
      ...snapshot.owner,
      updated_at: nowIso,
      passkeys: [...snapshot.owner.passkeys, passkey],
    };

    const auditOk = this.auditAuth({
      actor_type: 'owner',
      actor_id: snapshot.owner.owner_id,
      event_type: 'auth.passkey.registered',
      resource_id: `owner:${snapshot.owner.owner_id}`,
      action: 'auth:register_passkey',
      outcome: 'success',
      correlation_id: params.correlation_id,
      metadata: {
        credential_id: passkey.credential_id,
        algorithm: passkey.algorithm,
      },
    });
    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Passkey registration aborted because security audit logging failed.',
      };
    }

    this.store.save({
      ...snapshot,
      owner: updatedOwner,
    });

    return { ok: true, credential_id: passkey.credential_id };
  }

  // -------------------- Stage 4.5 Owner Profile, MFA & Session Controls --------------------

  getOwnerProfile(params: {
    principal: RbacPrincipal;
    correlation_id: string;
  }): { ok: true; profile: OwnerProfileSummary } | AuthFailureResult {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'auth:admin',
      resource_id: `owner:${params.principal.actor_id}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const snapshot = this.store.load();
    if (!snapshot.owner || snapshot.owner.owner_id !== params.principal.actor_id) {
      return {
        ok: false,
        code: 'OWNER_NOT_FOUND',
        error: 'Authenticated owner account was not found.',
      };
    }

    const owner = snapshot.owner;
    return {
      ok: true,
      profile: {
        owner_id: owner.owner_id,
        username: owner.username,
        email: owner.email,
        display_name: owner.display_name ?? owner.username,
        timezone: owner.timezone ?? 'UTC',
        role: 'owner',
        created_at: owner.created_at,
        updated_at: owner.updated_at,
        mfa_enabled_count: owner.mfa_factors.filter((f) => f.enabled).length,
        passkeys_count: owner.passkeys.length,
        recovery_codes_total: owner.recovery_codes.length,
        recovery_codes_remaining: owner.recovery_codes.filter((c) => c.used_at === null)
          .length,
      },
    };
  }

  updateOwnerProfile(params: {
    principal: RbacPrincipal;
    display_name?: string;
    email?: string;
    timezone?: string;
    correlation_id: string;
  }): { ok: true; profile: OwnerProfileSummary } | AuthFailureResult {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'auth:admin',
      resource_id: `owner:${params.principal.actor_id}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const snapshot = this.store.load();
    if (!snapshot.owner || snapshot.owner.owner_id !== params.principal.actor_id) {
      return {
        ok: false,
        code: 'OWNER_NOT_FOUND',
        error: 'Authenticated owner account was not found.',
      };
    }

    const owner = snapshot.owner;
    const nextEmail =
      params.email !== undefined ? params.email.trim().toLowerCase() : owner.email;
    if (!EMAIL_PATTERN.test(nextEmail)) {
      return {
        ok: false,
        code: 'INVALID_EMAIL',
        error: 'A valid owner email address is required.',
      };
    }

    const nextDisplayName =
      params.display_name !== undefined
        ? params.display_name.trim().slice(0, 100)
        : (owner.display_name ?? owner.username);
    if (nextDisplayName.length === 0) {
      return {
        ok: false,
        code: 'INVALID_DISPLAY_NAME',
        error: 'Display name must be between 1 and 100 characters.',
      };
    }

    const nextTimezone =
      params.timezone !== undefined
        ? params.timezone.trim().slice(0, 64)
        : (owner.timezone ?? 'UTC');
    if (nextTimezone.length === 0) {
      return {
        ok: false,
        code: 'INVALID_TIMEZONE',
        error: 'Timezone must be a valid non-empty string.',
      };
    }

    const nowIso = this.clock().toISOString();
    const updatedOwner: StoredOwnerAccount = {
      ...owner,
      email: nextEmail,
      display_name: nextDisplayName,
      timezone: nextTimezone,
      updated_at: nowIso,
    };

    const auditOk = this.auditAuth({
      actor_type: 'owner',
      actor_id: owner.owner_id,
      event_type: 'auth.profile.updated',
      resource_id: `owner:${owner.owner_id}`,
      action: 'auth:update_profile',
      outcome: 'success',
      correlation_id: params.correlation_id,
      metadata: {
        email_changed: nextEmail !== owner.email,
        timezone: nextTimezone,
      },
    });
    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Profile update aborted because security audit logging failed.',
      };
    }

    this.store.save({
      ...snapshot,
      owner: updatedOwner,
    });

    return this.getOwnerProfile({
      principal: params.principal,
      correlation_id: params.correlation_id,
    });
  }

  async changePassword(params: {
    principal: RbacPrincipal;
    current_password: string;
    new_password: string;
    keep_session_id?: string;
    correlation_id: string;
  }): Promise<{ ok: true; revoked_other_sessions: number } | AuthFailureResult> {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'auth:admin',
      resource_id: `owner:${params.principal.actor_id}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const snapshot = this.store.load();
    if (!snapshot.owner || snapshot.owner.owner_id !== params.principal.actor_id) {
      return {
        ok: false,
        code: 'OWNER_NOT_FOUND',
        error: 'Authenticated owner account was not found.',
      };
    }

    const currentOk = await verifySecretArgon2id(
      params.current_password,
      snapshot.owner.password_hash,
    );
    if (!currentOk) {
      this.auditAuth({
        actor_type: 'owner',
        actor_id: snapshot.owner.owner_id,
        event_type: 'auth.password.changed',
        resource_id: `owner:${snapshot.owner.owner_id}`,
        action: 'auth:change_password',
        outcome: 'failure',
        correlation_id: params.correlation_id,
        metadata: { reason_code: 'INVALID_CURRENT_PASSWORD' },
      });
      return {
        ok: false,
        code: 'INVALID_CURRENT_PASSWORD',
        error: 'Current password is incorrect.',
      };
    }

    const strength = validatePasswordStrength(
      params.new_password,
      this.config.passwordPolicy,
    );
    if (!strength.valid) {
      return { ok: false, code: strength.code, error: strength.error };
    }

    if (this.secretsManager) {
      const distinctCheck =
        this.secretsManager.assertPasswordDistinctFromWorkerToken(
          params.new_password,
        );
      if (!distinctCheck.ok) {
        return {
          ok: false,
          code: distinctCheck.code,
          error: distinctCheck.error,
        };
      }
    }

    const newHash = await hashSecretArgon2id(
      params.new_password,
      this.config.argon2id,
    );
    const nowIso = this.clock().toISOString();

    const revokeOthers = params.keep_session_id
      ? this.sessionManager.revokeOtherSessionsForActor(
          snapshot.owner.owner_id,
          params.keep_session_id,
          snapshot.sessions,
          'password_changed',
        )
      : { revokedCount: 0, updatedSessions: snapshot.sessions };

    const updatedOwner: StoredOwnerAccount = {
      ...snapshot.owner,
      password_hash: newHash,
      updated_at: nowIso,
    };

    const auditOk = this.auditAuth({
      actor_type: 'owner',
      actor_id: snapshot.owner.owner_id,
      event_type: 'auth.password.changed',
      resource_id: `owner:${snapshot.owner.owner_id}`,
      action: 'auth:change_password',
      outcome: 'success',
      correlation_id: params.correlation_id,
      metadata: { revoked_other_sessions: revokeOthers.revokedCount },
    });
    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Password change aborted because security audit logging failed.',
      };
    }

    this.store.save({
      ...snapshot,
      owner: updatedOwner,
      sessions: revokeOthers.updatedSessions,
    });

    return { ok: true, revoked_other_sessions: revokeOthers.revokedCount };
  }

  listSessions(params: {
    principal: RbacPrincipal;
    current_session_id?: string;
    include_revoked?: boolean;
    correlation_id: string;
  }): { ok: true; sessions: ActiveSessionSummary[] } | AuthFailureResult {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'auth:admin',
      resource_id: `owner:${params.principal.actor_id}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const snapshot = this.store.load();
    const nowMs = this.clock().getTime();
    const items: ActiveSessionSummary[] = [];

    for (const s of snapshot.sessions) {
      if (s.actor_id !== params.principal.actor_id) continue;
      const isExpired =
        new Date(s.expires_at).getTime() <= nowMs ||
        new Date(s.idle_expires_at).getTime() <= nowMs;
      if (!params.include_revoked && (s.revoked_at !== null || isExpired)) {
        continue;
      }
      const meta = this.sessionManager.decryptSessionMetadata(s);
      items.push({
        session_id: s.session_id,
        actor_id: s.actor_id,
        role: s.role,
        created_at: s.created_at,
        last_seen_at: s.last_seen_at,
        idle_expires_at: s.idle_expires_at,
        expires_at: s.expires_at,
        revoked_at: s.revoked_at,
        revocation_reason: s.revocation_reason,
        is_current: s.session_id === params.current_session_id,
        client_ip: meta?.client_ip ?? null,
        user_agent: meta?.user_agent ?? null,
      });
    }

    items.sort(
      (a, b) =>
        new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime(),
    );
    return { ok: true, sessions: items };
  }

  revokeOtherSessions(params: {
    principal: RbacPrincipal;
    keep_session_id: string;
    correlation_id: string;
  }): { ok: true; revoked_count: number } | AuthFailureResult {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'auth:admin',
      resource_id: `owner:${params.principal.actor_id}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const snapshot = this.store.load();
    const { revokedCount, updatedSessions } =
      this.sessionManager.revokeOtherSessionsForActor(
        params.principal.actor_id,
        params.keep_session_id,
        snapshot.sessions,
        'owner_revoked_other_sessions',
      );

    const auditOk = this.auditAuth({
      actor_type: 'owner',
      actor_id: params.principal.actor_id,
      event_type: 'auth.session.revoked_others',
      resource_id: `owner:${params.principal.actor_id}`,
      action: 'auth:revoke_other_sessions',
      outcome: 'success',
      correlation_id: params.correlation_id,
      metadata: {
        keep_session_id: params.keep_session_id,
        revoked_count: revokedCount,
      },
    });
    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Session revocation aborted because security audit logging failed.',
      };
    }

    this.store.save({
      ...snapshot,
      sessions: updatedSessions,
    });

    return { ok: true, revoked_count: revokedCount };
  }

  listMfaFactors(params: {
    principal: RbacPrincipal;
    correlation_id: string;
  }):
    | {
        ok: true;
        factors: MfaFactorSummary[];
        passkeys: Array<{
          credential_id: string;
          label: string;
          algorithm: string;
          registered_at: string;
          last_used_at: string | null;
        }>;
      }
    | AuthFailureResult {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'auth:admin',
      resource_id: `owner:${params.principal.actor_id}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const snapshot = this.store.load();
    if (!snapshot.owner || snapshot.owner.owner_id !== params.principal.actor_id) {
      return {
        ok: false,
        code: 'OWNER_NOT_FOUND',
        error: 'Authenticated owner account was not found.',
      };
    }

    return {
      ok: true,
      factors: snapshot.owner.mfa_factors.map((f) => ({
        factor_id: f.factor_id,
        type: f.type,
        label: f.label,
        enabled: f.enabled,
        enrolled_at: f.enrolled_at,
        last_used_step: f.last_used_step,
      })),
      passkeys: snapshot.owner.passkeys.map((p) => ({
        credential_id: p.credential_id,
        label: p.label,
        algorithm: p.algorithm,
        registered_at: p.registered_at,
        last_used_at: p.last_used_at,
      })),
    };
  }

  async toggleMfaFactor(params: {
    principal: RbacPrincipal;
    factor_id: string;
    enabled: boolean;
    current_password: string;
    correlation_id: string;
  }): Promise<{ ok: true; factor: MfaFactorSummary } | AuthFailureResult> {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'auth:admin',
      resource_id: `mfa:${params.factor_id}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const snapshot = this.store.load();
    if (!snapshot.owner || snapshot.owner.owner_id !== params.principal.actor_id) {
      return {
        ok: false,
        code: 'OWNER_NOT_FOUND',
        error: 'Authenticated owner account was not found.',
      };
    }

    const pwValid = await verifySecretArgon2id(
      params.current_password,
      snapshot.owner.password_hash,
    );
    if (!pwValid) {
      return {
        ok: false,
        code: 'INVALID_CURRENT_PASSWORD',
        error: 'Current owner password verification is required to change MFA status.',
      };
    }

    const target = snapshot.owner.mfa_factors.find(
      (f) => f.factor_id === params.factor_id,
    );
    if (!target) {
      return {
        ok: false,
        code: 'MFA_FACTOR_NOT_FOUND',
        error: 'Target MFA factor was not found.',
      };
    }

    const nowIso = this.clock().toISOString();
    const updatedFactors = snapshot.owner.mfa_factors.map((f) =>
      f.factor_id === params.factor_id ? { ...f, enabled: params.enabled } : f,
    );

    const auditOk = this.auditAuth({
      actor_type: 'owner',
      actor_id: snapshot.owner.owner_id,
      event_type: 'auth.mfa.toggled',
      resource_id: `mfa:${params.factor_id}`,
      action: 'auth:toggle_mfa',
      outcome: 'success',
      correlation_id: params.correlation_id,
      metadata: { factor_id: params.factor_id, enabled: params.enabled },
    });
    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'MFA update aborted because security audit logging failed.',
      };
    }

    this.store.save({
      ...snapshot,
      owner: {
        ...snapshot.owner,
        updated_at: nowIso,
        mfa_factors: updatedFactors,
      },
    });

    const next = updatedFactors.find((f) => f.factor_id === params.factor_id)!;
    return {
      ok: true,
      factor: {
        factor_id: next.factor_id,
        type: next.type,
        label: next.label,
        enabled: next.enabled,
        enrolled_at: next.enrolled_at,
        last_used_step: next.last_used_step,
      },
    };
  }

  async removeMfaFactor(params: {
    principal: RbacPrincipal;
    factor_id: string;
    current_password: string;
    correlation_id: string;
  }): Promise<{ ok: true; factor_id: string } | AuthFailureResult> {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'auth:admin',
      resource_id: `mfa:${params.factor_id}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const snapshot = this.store.load();
    if (!snapshot.owner || snapshot.owner.owner_id !== params.principal.actor_id) {
      return {
        ok: false,
        code: 'OWNER_NOT_FOUND',
        error: 'Authenticated owner account was not found.',
      };
    }

    const pwValid = await verifySecretArgon2id(
      params.current_password,
      snapshot.owner.password_hash,
    );
    if (!pwValid) {
      return {
        ok: false,
        code: 'INVALID_CURRENT_PASSWORD',
        error: 'Current owner password verification is required to remove an MFA factor.',
      };
    }

    const exists = snapshot.owner.mfa_factors.some(
      (f) => f.factor_id === params.factor_id,
    );
    if (!exists) {
      return {
        ok: false,
        code: 'MFA_FACTOR_NOT_FOUND',
        error: 'Target MFA factor was not found.',
      };
    }

    const nowIso = this.clock().toISOString();
    const auditOk = this.auditAuth({
      actor_type: 'owner',
      actor_id: snapshot.owner.owner_id,
      event_type: 'auth.mfa.removed',
      resource_id: `mfa:${params.factor_id}`,
      action: 'auth:remove_mfa',
      outcome: 'success',
      correlation_id: params.correlation_id,
      metadata: { factor_id: params.factor_id },
    });
    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'MFA removal aborted because security audit logging failed.',
      };
    }

    this.store.save({
      ...snapshot,
      owner: {
        ...snapshot.owner,
        updated_at: nowIso,
        mfa_factors: snapshot.owner.mfa_factors.filter(
          (f) => f.factor_id !== params.factor_id,
        ),
      },
    });

    return { ok: true, factor_id: params.factor_id };
  }

  async regenerateRecoveryCodes(params: {
    principal: RbacPrincipal;
    current_password: string;
    correlation_id: string;
  }): Promise<{ ok: true; recovery_codes: string[] } | AuthFailureResult> {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'auth:admin',
      resource_id: `owner:${params.principal.actor_id}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const snapshot = this.store.load();
    if (!snapshot.owner || snapshot.owner.owner_id !== params.principal.actor_id) {
      return {
        ok: false,
        code: 'OWNER_NOT_FOUND',
        error: 'Authenticated owner account was not found.',
      };
    }

    const pwValid = await verifySecretArgon2id(
      params.current_password,
      snapshot.owner.password_hash,
    );
    if (!pwValid) {
      return {
        ok: false,
        code: 'INVALID_CURRENT_PASSWORD',
        error: 'Current owner password verification is required to regenerate recovery codes.',
      };
    }

    const { plaintextCodes, hashedRecords } = await this.generateRecoveryCodes();
    const nowIso = this.clock().toISOString();

    const auditOk = this.auditAuth({
      actor_type: 'owner',
      actor_id: snapshot.owner.owner_id,
      event_type: 'auth.recovery.generated',
      resource_id: `owner:${snapshot.owner.owner_id}`,
      action: 'auth:regenerate_recovery_codes',
      outcome: 'success',
      correlation_id: params.correlation_id,
      metadata: { code_count: plaintextCodes.length },
    });
    if (!auditOk) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: 'Recovery code regeneration aborted because security audit logging failed.',
      };
    }

    this.store.save({
      ...snapshot,
      owner: {
        ...snapshot.owner,
        updated_at: nowIso,
        recovery_codes: hashedRecords,
      },
    });

    return { ok: true, recovery_codes: plaintextCodes };
  }
}
