import crypto from 'node:crypto';
import argon2 from 'argon2';

import type { ExecutionEnvironment } from '../../contracts/types/index.ts';
import type { EncryptedEnvelope, SecurityConfig } from './validate-security-config.ts';

export type PasswordValidationResult =
  | { valid: true }
  | { valid: false; code: string; error: string };

export interface TransportCheckInput {
  protocol?: string;
  encrypted?: boolean;
  host?: string;
  forwardedProto?: string;
  environment?: ExecutionEnvironment | 'development' | 'test';
}

export type TransportCheckResult =
  | { allowed: true; protocol: 'https' | 'http-loopback-dev' }
  | { allowed: false; code: string; error: string };

const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]);

export function constantTimeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Perform a dummy equal-length compare to reduce timing variance.
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function generateOpaqueToken(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 128) {
    throw new Error('Opaque token length must be between 16 and 128 bytes.');
  }
  return crypto.randomBytes(byteLength).toString('base64url');
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function validatePasswordStrength(
  password: string,
  policy: SecurityConfig['passwordPolicy'],
): PasswordValidationResult {
  if (typeof password !== 'string') {
    return {
      valid: false,
      code: 'INVALID_PASSWORD_TYPE',
      error: 'Password must be a string.',
    };
  }

  if (password.length < policy.minLength) {
    return {
      valid: false,
      code: 'PASSWORD_TOO_SHORT',
      error: `Password must be at least ${policy.minLength} characters long.`,
    };
  }

  if (password.length > policy.maxLength) {
    return {
      valid: false,
      code: 'PASSWORD_TOO_LONG',
      error: `Password must not exceed ${policy.maxLength} characters.`,
    };
  }

  if (/^\s|\s$/.test(password)) {
    return {
      valid: false,
      code: 'PASSWORD_LEADING_TRAILING_WHITESPACE',
      error: 'Password must not begin or end with whitespace.',
    };
  }

  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  if (/[^a-zA-Z0-9\s]/.test(password)) classes += 1;

  if (classes < policy.requireCharacterClasses) {
    return {
      valid: false,
      code: 'PASSWORD_COMPLEXITY_INSUFFICIENT',
      error: `Password must contain at least ${policy.requireCharacterClasses} character classes (lowercase, uppercase, digits, symbols).`,
    };
  }

  return { valid: true };
}

/**
 * Hashes a secret password or recovery code using Argon2id with an explicit
 * cryptographically random per-record salt. Plaintext input is never persisted.
 */
export async function hashSecretArgon2id(
  secretValue: string,
  params: SecurityConfig['argon2id'],
): Promise<string> {
  if (typeof secretValue !== 'string' || secretValue.length === 0) {
    throw new Error('Cannot hash an empty secret.');
  }

  const uniqueSalt = crypto.randomBytes(params.saltBytes);
  return argon2.hash(secretValue, {
    type: argon2.argon2id,
    memoryCost: params.memoryCostKiB,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
    hashLength: params.hashLength,
    salt: uniqueSalt,
  });
}

export async function verifySecretArgon2id(
  secretValue: string,
  storedHash: string,
): Promise<boolean> {
  if (
    typeof secretValue !== 'string' ||
    secretValue.length === 0 ||
    typeof storedHash !== 'string' ||
    !storedHash.startsWith('$argon2id$')
  ) {
    return false;
  }

  try {
    return await argon2.verify(storedHash, secretValue);
  } catch {
    return false;
  }
}

/**
 * Generates a high-entropy 32-byte key from explicit key material using HKDF-SHA256
 * with domain separation, or accepts an explicit 32-byte Buffer.
 */
export function deriveAes256Key(
  keyMaterial: Buffer | string,
  context = 'tejaura-stage2b-storage-v1',
): Buffer {
  if (Buffer.isBuffer(keyMaterial)) {
    if (keyMaterial.length < 32) {
      throw new Error('AES-256-GCM key buffer must be at least 32 bytes.');
    }
    return Buffer.from(
      crypto.hkdfSync(
        'sha256',
        keyMaterial,
        Buffer.from('tejaura-hkdf-salt-v1', 'utf8'),
        Buffer.from(context, 'utf8'),
        32,
      ),
    );
  }

  if (typeof keyMaterial !== 'string' || keyMaterial.trim().length < 16) {
    throw new Error(
      'Encryption master key material must be at least 16 characters.',
    );
  }

  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(keyMaterial, 'utf8'),
      Buffer.from('tejaura-hkdf-salt-v1', 'utf8'),
      Buffer.from(context, 'utf8'),
      32,
    ),
  );
}

export function encryptAes256Gcm(
  plaintext: string,
  key: Buffer,
  aad?: string,
  keyId?: string,
): EncryptedEnvelope {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('AES-256-GCM encryption requires a 32-byte key.');
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) {
    cipher.setAAD(Buffer.from(aad, 'utf8'));
  }

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const envelope: EncryptedEnvelope = {
    alg: 'aes-256-gcm',
    iv_b64: iv.toString('base64'),
    tag_b64: tag.toString('base64'),
    ciphertext_b64: ciphertext.toString('base64'),
  };

  if (keyId) {
    envelope.key_id = keyId;
  }

  return envelope;
}

export function decryptAes256Gcm(
  envelope: EncryptedEnvelope,
  key: Buffer,
  aad?: string,
): string {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('AES-256-GCM decryption requires a 32-byte key.');
  }
  if (!envelope || envelope.alg !== 'aes-256-gcm') {
    throw new Error('Unsupported or malformed encryption envelope.');
  }

  const iv = Buffer.from(envelope.iv_b64, 'base64');
  const tag = Buffer.from(envelope.tag_b64, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext_b64, 'base64');

  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('Invalid AES-256-GCM IV or authentication tag length.');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) {
    decipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function normalizeHostName(rawHost: string | undefined): string {
  if (!rawHost) return '';
  const trimmed = rawHost.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const endIdx = trimmed.indexOf(']');
    return endIdx >= 0 ? trimmed.slice(0, endIdx + 1) : trimmed;
  }
  return trimmed.split(':')[0] ?? '';
}

export function enforceHttpsTransport(
  input: TransportCheckInput,
  transport: SecurityConfig['transport'],
): TransportCheckResult {
  if (input.encrypted === true) {
    return { allowed: true, protocol: 'https' };
  }

  const rawProto = (input.protocol ?? '').trim().toLowerCase().replace(/:$/, '');
  if (rawProto === 'https') {
    return { allowed: true, protocol: 'https' };
  }

  if (transport.trustProxyProtoHeader && input.forwardedProto) {
    const firstProto = input.forwardedProto
      .split(',')[0]
      ?.trim()
      .toLowerCase();
    if (firstProto === 'https') {
      return { allowed: true, protocol: 'https' };
    }
  }

  const host = normalizeHostName(input.host);
  const env = input.environment ?? 'production';
  const isNonDeploymentEnv =
    env === 'local' || env === 'sandbox' || env === 'development' || env === 'test';

  if (
    transport.allowLocalLoopbackHttpInDev &&
    isNonDeploymentEnv &&
    LOOPBACK_HOSTS.has(host)
  ) {
    return { allowed: true, protocol: 'http-loopback-dev' };
  }

  return {
    allowed: false,
    code: 'HTTPS_REQUIRED',
    error:
      'HTTPS transport is required for TEJAURA authentication, sessions, and sensitive operations.',
  };
}
