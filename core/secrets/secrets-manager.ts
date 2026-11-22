import type { AuditLogger } from '../audit/index.ts';
import { authorizeRbac, type RbacPrincipal } from '../rbac/index.ts';
import {
  constantTimeEqualStrings,
  decryptAes256Gcm,
  deriveAes256Key,
  encryptAes256Gcm,
} from '../security/index.ts';
import type { EnvSecretProvider } from './env-secret-provider.ts';
import {
  AIRLLM_WORKER_TOKEN_ENV_VAR,
  type EncryptedVaultBackend,
  type SecretMetadata,
  type SecretOperationResult,
  type SecretScope,
  type StoredSecretEntry,
} from './secret-types.ts';
import { InMemoryEncryptedVaultBackend } from './vault-backends.ts';

const SECRET_KEY_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/;
const VALID_SCOPES = new Set<SecretScope>([
  'worker_runtime',
  'external_credential',
  'encryption_key',
  'owner_credential',
]);
const MAX_SECRET_VALUE_LENGTH = 8192;

export interface SecretsManagerOptions {
  masterKeyMaterial: Buffer | string;
  envProvider?: EnvSecretProvider;
  vaultBackend?: EncryptedVaultBackend;
  auditLogger?: AuditLogger;
  clock?: () => Date;
}

function aadFor(key: string, scope: string): string {
  return `secret:${key}:${scope}`;
}

export class SecretsManager {
  private readonly vaultBackend: EncryptedVaultBackend;
  private readonly envProvider?: EnvSecretProvider;
  private readonly auditLogger?: AuditLogger;
  private readonly clock: () => Date;
  private readonly encryptionKey: Buffer;

  constructor(options: SecretsManagerOptions) {
    this.encryptionKey = deriveAes256Key(
      options.masterKeyMaterial,
      'tejaura-secrets-vault-v1',
    );
    this.vaultBackend =
      options.vaultBackend ?? new InMemoryEncryptedVaultBackend();
    this.envProvider = options.envProvider;
    this.auditLogger = options.auditLogger;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Reads the internal AirLLM worker token. Only owner and worker_service
   * principals are permitted; agents and frontend callers are denied.
   */
  getAirLlmWorkerToken(params: {
    principal: RbacPrincipal;
    correlation_id: string;
  }): SecretOperationResult<string> {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'worker:airllm:token',
      resource_id: `secret:${AIRLLM_WORKER_TOKEN_ENV_VAR}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      this.auditAccess(
        params.principal,
        AIRLLM_WORKER_TOKEN_ENV_VAR,
        'read',
        'denied',
        params.correlation_id,
        'secret.access_denied',
        authz.reason_code,
      );
      return {
        ok: false,
        code: authz.reason_code,
        error: authz.reason,
      };
    }

    const token = this.envProvider?.get(AIRLLM_WORKER_TOKEN_ENV_VAR) ?? null;
    if (!token) {
      this.auditAccess(
        params.principal,
        AIRLLM_WORKER_TOKEN_ENV_VAR,
        'read',
        'failure',
        params.correlation_id,
        'secret.accessed',
        'AIRLLM_WORKER_TOKEN_NOT_CONFIGURED',
      );
      return {
        ok: false,
        code: 'AIRLLM_WORKER_TOKEN_NOT_CONFIGURED',
        error: `Environment variable ${AIRLLM_WORKER_TOKEN_ENV_VAR} is not configured.`,
      };
    }

    const audit = this.auditAccess(
      params.principal,
      AIRLLM_WORKER_TOKEN_ENV_VAR,
      'read',
      'success',
      params.correlation_id,
      'secret.accessed',
    );
    if (!audit.ok) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: `Secret read aborted because audit logging failed: ${audit.error}`,
      };
    }

    return { ok: true, value: token };
  }

  getSecret(params: {
    principal: RbacPrincipal;
    key: string;
    correlation_id: string;
  }): SecretOperationResult<string> {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'secrets:read',
      resource_id: `secret:${params.key}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      this.auditAccess(
        params.principal,
        params.key,
        'read',
        'denied',
        params.correlation_id,
        'secret.access_denied',
        authz.reason_code,
      );
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const entries = this.vaultBackend.load();
    const entry = entries[params.key];
    if (!entry) {
      return {
        ok: false,
        code: 'SECRET_NOT_FOUND',
        error: `Secret "${params.key}" was not found.`,
      };
    }

    let value: string;
    try {
      value = decryptAes256Gcm(
        entry.envelope,
        this.encryptionKey,
        aadFor(entry.key, entry.scope),
      );
    } catch {
      this.auditAccess(
        params.principal,
        params.key,
        'read',
        'failure',
        params.correlation_id,
        'secret.accessed',
        'SECRET_DECRYPTION_FAILED',
      );
      return {
        ok: false,
        code: 'SECRET_DECRYPTION_FAILED',
        error: `Secret "${params.key}" could not be decrypted.`,
      };
    }

    const audit = this.auditAccess(
      params.principal,
      params.key,
      'read',
      'success',
      params.correlation_id,
      'secret.accessed',
    );
    if (!audit.ok) {
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: `Secret read aborted because audit logging failed: ${audit.error}`,
      };
    }

    return { ok: true, value };
  }

  setSecret(params: {
    principal: RbacPrincipal;
    key: string;
    value: string;
    scope: SecretScope;
    correlation_id: string;
  }): SecretOperationResult<SecretMetadata> {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'secrets:write',
      resource_id: `secret:${params.key}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      this.auditAccess(
        params.principal,
        params.key,
        'write',
        'denied',
        params.correlation_id,
        'secret.access_denied',
        authz.reason_code,
      );
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    if (!SECRET_KEY_PATTERN.test(params.key)) {
      return {
        ok: false,
        code: 'INVALID_SECRET_KEY',
        error:
          'Secret keys must be uppercase environment-style identifiers (A-Z, 0-9, underscore).',
      };
    }

    if (!VALID_SCOPES.has(params.scope)) {
      return {
        ok: false,
        code: 'INVALID_SECRET_SCOPE',
        error: `Unsupported secret scope "${String(params.scope)}".`,
      };
    }

    if (
      typeof params.value !== 'string' ||
      params.value.length === 0 ||
      params.value.length > MAX_SECRET_VALUE_LENGTH
    ) {
      return {
        ok: false,
        code: 'INVALID_SECRET_VALUE',
        error: `Secret value must be between 1 and ${MAX_SECRET_VALUE_LENGTH} characters.`,
      };
    }

    const entries = this.vaultBackend.load();
    const previous = entries[params.key] ?? null;
    const nowIso = this.clock().toISOString();
    const envelope = encryptAes256Gcm(
      params.value,
      this.encryptionKey,
      aadFor(params.key, params.scope),
    );

    const entry: StoredSecretEntry = {
      key: params.key,
      scope: params.scope,
      envelope,
      created_at: previous?.created_at ?? nowIso,
      updated_at: nowIso,
      updated_by: params.principal.actor_id,
    };

    const nextEntries = { ...entries, [params.key]: entry };
    this.vaultBackend.save(nextEntries);

    const audit = this.auditAccess(
      params.principal,
      params.key,
      previous ? 'rotate' : 'write',
      'success',
      params.correlation_id,
      previous ? 'secret.rotated' : 'secret.stored',
      undefined,
      { scope: params.scope },
    );
    if (!audit.ok) {
      if (previous) {
        this.vaultBackend.save({ ...entries, [params.key]: previous });
      } else {
        const rolledBack = { ...nextEntries };
        delete rolledBack[params.key];
        this.vaultBackend.save(rolledBack);
      }
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: `Secret write rolled back because audit logging failed: ${audit.error}`,
      };
    }

    return {
      ok: true,
      value: {
        key: entry.key,
        source: 'vault',
        scope: entry.scope,
        present: true,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
      },
    };
  }

  deleteSecret(params: {
    principal: RbacPrincipal;
    key: string;
    correlation_id: string;
  }): SecretOperationResult<{ key: string; deleted: boolean }> {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'secrets:rotate',
      resource_id: `secret:${params.key}`,
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      this.auditAccess(
        params.principal,
        params.key,
        'delete',
        'denied',
        params.correlation_id,
        'secret.access_denied',
        authz.reason_code,
      );
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const entries = this.vaultBackend.load();
    if (!entries[params.key]) {
      return {
        ok: false,
        code: 'SECRET_NOT_FOUND',
        error: `Secret "${params.key}" was not found.`,
      };
    }

    const nextEntries = { ...entries };
    delete nextEntries[params.key];
    this.vaultBackend.save(nextEntries);

    const audit = this.auditAccess(
      params.principal,
      params.key,
      'delete',
      'success',
      params.correlation_id,
      'secret.deleted',
    );
    if (!audit.ok) {
      this.vaultBackend.save(entries);
      return {
        ok: false,
        code: 'AUDIT_STORAGE_FAILURE',
        error: `Secret deletion rolled back because audit logging failed: ${audit.error}`,
      };
    }

    return { ok: true, value: { key: params.key, deleted: true } };
  }

  listMetadata(params: {
    principal: RbacPrincipal;
    correlation_id: string;
  }): SecretOperationResult<SecretMetadata[]> {
    const authz = authorizeRbac({
      principal: params.principal,
      permission: 'secrets:inventory',
      resource_id: 'secret:inventory',
      correlation_id: params.correlation_id,
      auditLogger: this.auditLogger,
    });
    if (!authz.allowed) {
      return { ok: false, code: authz.reason_code, error: authz.reason };
    }

    const entries = this.vaultBackend.load();
    const metadata: SecretMetadata[] = Object.values(entries).map((entry) => ({
      key: entry.key,
      source: 'vault',
      scope: entry.scope,
      present: true,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    }));

    metadata.push({
      key: AIRLLM_WORKER_TOKEN_ENV_VAR,
      source: 'env',
      scope: 'worker_runtime',
      present: this.envProvider?.has(AIRLLM_WORKER_TOKEN_ENV_VAR) ?? false,
    });

    return { ok: true, value: metadata };
  }

  assertPasswordDistinctFromWorkerToken(
    password: string,
  ): { ok: true } | { ok: false; code: string; error: string } {
    const token = this.envProvider?.get(AIRLLM_WORKER_TOKEN_ENV_VAR) ?? null;
    if (!token) {
      return { ok: true };
    }
    if (
      typeof password === 'string' &&
      constantTimeEqualStrings(password, token)
    ) {
      return {
        ok: false,
        code: 'WORKER_TOKEN_PASSWORD_CONFLICT',
        error:
          'Owner password must never be identical to the internal AirLLM worker token.',
      };
    }
    return { ok: true };
  }

  private auditAccess(
    principal: RbacPrincipal,
    key: string,
    action: string,
    outcome: 'success' | 'failure' | 'denied',
    correlationId: string,
    eventType:
      | 'secret.accessed'
      | 'secret.stored'
      | 'secret.rotated'
      | 'secret.deleted'
      | 'secret.access_denied',
    reasonCode?: string,
    metadata?: Record<string, unknown>,
  ): { ok: true } | { ok: false; error: string } {
    if (!this.auditLogger) {
      return { ok: true };
    }
    const res = this.auditLogger.logSecretAccess({
      actor_type: principal.actor_type,
      actor_id: principal.actor_id,
      secret_key_name: key,
      event_type: eventType,
      action,
      outcome,
      correlation_id: correlationId,
      metadata: {
        ...(metadata ?? {}),
        ...(reasonCode ? { reason_code: reasonCode } : {}),
      },
    });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
}
