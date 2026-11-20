import Ajv2020Module from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import addFormatsModule from 'ajv-formats';

import type { ValidationResult } from '../../contracts/validation/index.ts';
import identityStoreSchema from './identity-store.schema.json' with { type: 'json' };
import securityConfigSchema from './security-config.schema.json' with { type: 'json' };

type Ajv2020Constructor = typeof Ajv2020Module;
type AddFormatsFn = typeof addFormatsModule;

const Ajv2020 =
  (Ajv2020Module as unknown as { default?: Ajv2020Constructor }).default ??
  Ajv2020Module;
const addFormats =
  (addFormatsModule as unknown as { default?: AddFormatsFn }).default ??
  addFormatsModule;

export interface SecurityConfig {
  $schema?: string;
  schemaVersion: string;
  argon2id: {
    memoryCostKiB: number;
    timeCost: number;
    parallelism: number;
    saltBytes: number;
    hashLength: number;
  };
  passwordPolicy: {
    minLength: number;
    maxLength: number;
    requireCharacterClasses: number;
  };
  session: {
    cookieName: string;
    httpOnly: true;
    secure: true;
    sameSite: 'strict' | 'lax';
    path: '/';
    ttlSeconds: number;
    idleTimeoutSeconds: number;
    maxActiveSessionsPerOwner: number;
  };
  rateLimit: {
    maxAttempts: number;
    windowSeconds: number;
    lockoutSeconds: number;
  };
  transport: {
    enforceHttpsInDeployment: true;
    trustProxyProtoHeader: boolean;
    allowLocalLoopbackHttpInDev: boolean;
  };
  mfa: {
    allowTotpModule: boolean;
    allowPasskeyModule: boolean;
    requireMfaWhenEnrolled: true;
  };
  recovery: {
    codeCount: number;
    singleUse: true;
    revokeAllSessionsOnRecovery: true;
  };
  secrets: {
    workerTokenEnvVar: 'TEJAURA_AIRLLM_WORKER_TOKEN';
    masterKeyEnvVar: string;
    encryptionAlgorithm: 'aes-256-gcm';
    exposeToFrontend: false;
    exposeToAgents: false;
  };
}

export interface EncryptedEnvelope {
  alg: 'aes-256-gcm';
  iv_b64: string;
  tag_b64: string;
  ciphertext_b64: string;
  key_id?: string;
}

export interface StoredMfaFactor {
  factor_id: string;
  type: 'totp' | 'custom';
  label: string;
  enabled: boolean;
  enrolled_at: string;
  encrypted_secret: EncryptedEnvelope;
  last_used_step: number | null;
}

export interface StoredPasskeyCredential {
  credential_id: string;
  label: string;
  algorithm: 'ES256' | 'EdDSA' | 'custom';
  public_key_pem: string;
  sign_count: number;
  registered_at: string;
  last_used_at: string | null;
  transports: string[];
}

export interface StoredRecoveryCode {
  code_id: string;
  code_hash: string;
  used_at: string | null;
}

export type TejauraRole =
  | 'owner'
  | 'operator_readonly'
  | 'agent_restricted'
  | 'worker_service';

export interface StoredOwnerAccount {
  owner_id: string;
  username: string;
  email: string;
  password_hash: string;
  role: 'owner';
  created_at: string;
  updated_at: string;
  mfa_factors: StoredMfaFactor[];
  passkeys: StoredPasskeyCredential[];
  recovery_codes: StoredRecoveryCode[];
}

export interface StoredSessionRecord {
  session_id: string;
  token_hash: string;
  actor_id: string;
  role: TejauraRole;
  created_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  expires_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  encrypted_metadata: EncryptedEnvelope | null;
}

export interface IdentityStoreSnapshot {
  schemaVersion: string;
  owner: StoredOwnerAccount | null;
  sessions: StoredSessionRecord[];
  roleAssignments: Record<string, TejauraRole>;
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
  removeAdditional: false,
  useDefaults: false,
  coerceTypes: false,
});
addFormats(ajv);

const compileSecurityConfig = ajv.compile<SecurityConfig>(securityConfigSchema);
const compileIdentityStore = ajv.compile<IdentityStoreSnapshot>(identityStoreSchema);

const SECRET_LIKE_KEYS =
  /^(password|passphrase|secret|secret_?key|api_?key|token|private_?key|raw_?secret|master_?key)$/i;

function hasForbiddenSecretKey(
  value: unknown,
  path = '$',
  depth = 0,
): string | null {
  if (depth > 20 || value === null || typeof value !== 'object') {
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = hasForbiddenSecretKey(value[i], `${path}/${i}`, depth + 1);
      if (hit) {
        return hit;
      }
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_LIKE_KEYS.test(k)) {
      return `${path}/${k}`;
    }
    const hit = hasForbiddenSecretKey(v, `${path}/${k}`, depth + 1);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function mapErrors(errors: ErrorObject[] | null | undefined) {
  return (errors ?? []).map((e) => ({
    path: e.instancePath ? `$${e.instancePath}` : '$',
    keyword: e.keyword,
    message: e.message ?? 'Validation failed.',
    schema_path: e.schemaPath,
  }));
}

export function validateSecurityConfig(
  input: unknown,
): ValidationResult<SecurityConfig> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: '$',
          keyword: 'type',
          message: 'Security configuration must be a non-null JSON object.',
        },
      ],
    };
  }

  const secretPath = hasForbiddenSecretKey(input);
  if (secretPath) {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: secretPath,
          keyword: 'secret_forbidden_in_config',
          message: 'Plaintext secret-like fields are forbidden in security configuration.',
        },
      ],
    };
  }

  if (!compileSecurityConfig(input)) {
    return {
      valid: false,
      data: null,
      errors: mapErrors(compileSecurityConfig.errors),
    };
  }

  const cfg = input as SecurityConfig;
  if (cfg.passwordPolicy.maxLength < cfg.passwordPolicy.minLength) {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: '$/passwordPolicy/maxLength',
          keyword: 'password_policy_bounds',
          message: 'passwordPolicy.maxLength must be >= passwordPolicy.minLength.',
        },
      ],
    };
  }

  if (cfg.session.idleTimeoutSeconds > cfg.session.ttlSeconds) {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: '$/session/idleTimeoutSeconds',
          keyword: 'session_timeout_bounds',
          message: 'session.idleTimeoutSeconds cannot exceed session.ttlSeconds.',
        },
      ],
    };
  }

  return {
    valid: true,
    data: cfg,
    errors: [],
  };
}

export function validateIdentityStoreSnapshot(
  input: unknown,
): ValidationResult<IdentityStoreSnapshot> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: '$',
          keyword: 'type',
          message: 'Identity store snapshot must be a non-null JSON object.',
        },
      ],
    };
  }

  if (!compileIdentityStore(input)) {
    return {
      valid: false,
      data: null,
      errors: mapErrors(compileIdentityStore.errors),
    };
  }

  return {
    valid: true,
    data: input as IdentityStoreSnapshot,
    errors: [],
  };
}
