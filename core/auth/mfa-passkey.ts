import crypto from 'node:crypto';

import {
  constantTimeEqualStrings,
  decryptAes256Gcm,
  encryptAes256Gcm,
} from '../security/index.ts';
import type {
  StoredMfaFactor,
  StoredPasskeyCredential,
} from '../security/index.ts';
import type {
  MfaChallengeModule,
  MfaChallengeVerificationInput,
  MfaVerificationResult,
  PasskeyVerificationInput,
  PasskeyVerificationResult,
  PasskeyVerifierModule,
} from './auth-types.ts';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function decodeBase32(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error('Invalid base32 character in TOTP secret.');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

export function generateTotpCode(
  base32Secret: string,
  timestampMs: number,
  stepSeconds = 30,
  digits = 6,
): string {
  const secretBytes = decodeBase32(base32Secret);
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);

  const hmac = crypto.createHmac('sha1', secretBytes).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, '0');
}

export function createEncryptedTotpFactor(params: {
  factorId: string;
  label: string;
  ownerUsername: string;
  masterKey: Buffer;
  now: Date;
}): { factor: StoredMfaFactor; secretBase32: string; otpauthUri: string } {
  const rawSecret = crypto.randomBytes(20);
  const secretBase32 = encodeBase32(rawSecret);
  const aad = `mfa:${params.factorId}:totp`;
  const encryptedSecret = encryptAes256Gcm(
    secretBase32,
    params.masterKey,
    aad,
    'mfa-v1',
  );

  const issuer = encodeURIComponent('TEJAURA');
  const account = encodeURIComponent(params.ownerUsername);
  const otpauthUri = `otpauth://totp/${issuer}:${account}?secret=${secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

  return {
    factor: {
      factor_id: params.factorId,
      type: 'totp',
      label: params.label,
      enabled: true,
      enrolled_at: params.now.toISOString(),
      encrypted_secret: encryptedSecret,
      last_used_step: null,
    },
    secretBase32,
    otpauthUri,
  };
}

/**
 * RFC 6238 TOTP verifier module with AES-256-GCM secret decryption and
 * single-use time-step replay protection.
 */
export class TotpMfaModule implements MfaChallengeModule {
  readonly type = 'totp' as const;
  private readonly skewWindows: number;
  private readonly stepSeconds: number;

  constructor(options?: { skewWindows?: number; stepSeconds?: number }) {
    this.skewWindows = options?.skewWindows ?? 1;
    this.stepSeconds = options?.stepSeconds ?? 30;
  }

  verifyChallenge(input: MfaChallengeVerificationInput): MfaVerificationResult {
    if (!input.factor.enabled) {
      return {
        valid: false,
        code: 'MFA_FACTOR_DISABLED',
        error: 'MFA factor is disabled.',
      };
    }

    const cleanCode = (input.code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleanCode)) {
      return {
        valid: false,
        code: 'INVALID_MFA_CODE_FORMAT',
        error: 'TOTP verification requires a 6-digit numeric code.',
      };
    }

    let secretBase32: string;
    try {
      secretBase32 = decryptAes256Gcm(
        input.factor.encrypted_secret,
        input.masterKey,
        `mfa:${input.factor.factor_id}:totp`,
      );
    } catch {
      return {
        valid: false,
        code: 'MFA_SECRET_DECRYPT_FAILED',
        error: 'Failed to decrypt MFA factor secret.',
      };
    }

    const nowMs = input.now.getTime();
    const currentStep = Math.floor(nowMs / 1000 / this.stepSeconds);

    for (let delta = -this.skewWindows; delta <= this.skewWindows; delta += 1) {
      const candidateStep = currentStep + delta;
      if (
        input.factor.last_used_step !== null &&
        candidateStep <= input.factor.last_used_step
      ) {
        continue;
      }

      const expectedCode = generateTotpCode(
        secretBase32,
        candidateStep * this.stepSeconds * 1000,
        this.stepSeconds,
      );

      if (constantTimeEqualStrings(cleanCode, expectedCode)) {
        return {
          valid: true,
          next_used_step: candidateStep,
        };
      }
    }

    return {
      valid: false,
      code: 'MFA_VERIFICATION_FAILED',
      error: 'Invalid or already-consumed MFA verification code.',
    };
  }
}

export class MfaModuleRegistry {
  private readonly modules = new Map<string, MfaChallengeModule>();

  constructor(initialModules: MfaChallengeModule[] = [new TotpMfaModule()]) {
    for (const mod of initialModules) {
      this.modules.set(mod.type, mod);
    }
  }

  register(mod: MfaChallengeModule): void {
    this.modules.set(mod.type, mod);
  }

  get(type: string): MfaChallengeModule | null {
    return this.modules.get(type) ?? null;
  }
}

/**
 * Extensible WebAuthn / Passkey assertion verifier for ES256 (ECDSA P-256)
 * and EdDSA keys with challenge binding, origin verification, User Presence flag
 * check, and monotonic signature counter anti-cloning checks.
 */
export class WebAuthnPasskeyVerifier implements PasskeyVerifierModule {
  readonly algorithm: StoredPasskeyCredential['algorithm'];

  constructor(algorithm: StoredPasskeyCredential['algorithm'] = 'ES256') {
    this.algorithm = algorithm;
  }

  verifyAssertion(input: PasskeyVerificationInput): PasskeyVerificationResult {
    const { credential, assertion, expectedOrigin } = input;
    if (assertion.credential_id !== credential.credential_id) {
      return {
        valid: false,
        code: 'PASSKEY_CREDENTIAL_MISMATCH',
        error: 'Passkey assertion credential ID does not match registered credential.',
      };
    }

    let clientData: { type?: unknown; challenge?: unknown; origin?: unknown };
    let clientDataBytes: Buffer;
    try {
      clientDataBytes = Buffer.from(assertion.clientDataJSON_b64, 'base64url');
      clientData = JSON.parse(clientDataBytes.toString('utf8')) as {
        type?: unknown;
        challenge?: unknown;
        origin?: unknown;
      };
    } catch {
      return {
        valid: false,
        code: 'INVALID_PASSKEY_CLIENT_DATA',
        error: 'Passkey clientDataJSON could not be decoded.',
      };
    }

    if (clientData.type !== 'webauthn.get') {
      return {
        valid: false,
        code: 'INVALID_PASSKEY_CEREMONY_TYPE',
        error: 'Passkey assertion type must be "webauthn.get".',
      };
    }

    if (
      typeof clientData.challenge !== 'string' ||
      !constantTimeEqualStrings(clientData.challenge, assertion.challenge)
    ) {
      return {
        valid: false,
        code: 'PASSKEY_CHALLENGE_MISMATCH',
        error: 'Passkey challenge does not match issued server challenge.',
      };
    }

    if (clientData.origin !== expectedOrigin) {
      return {
        valid: false,
        code: 'PASSKEY_ORIGIN_MISMATCH',
        error: 'Passkey assertion origin does not match expected origin.',
      };
    }

    const authData = Buffer.from(assertion.authenticatorData_b64, 'base64url');
    if (authData.length < 37) {
      return {
        valid: false,
        code: 'INVALID_AUTHENTICATOR_DATA',
        error: 'Authenticator data must be at least 37 bytes.',
      };
    }

    // Check RP ID hash matches expected origin hostname.
    const expectedHostname = new URL(expectedOrigin).hostname;
    const expectedRpIdHash = crypto
      .createHash('sha256')
      .update(expectedHostname, 'utf8')
      .digest();
    const actualRpIdHash = authData.subarray(0, 32);
    if (!crypto.timingSafeEqual(actualRpIdHash, expectedRpIdHash)) {
      return {
        valid: false,
        code: 'PASSKEY_RP_ID_MISMATCH',
        error: 'Passkey authenticatorData RP ID hash mismatch.',
      };
    }

    // Bit 0 (0x01) is User Present (UP).
    const flags = authData[32]!;
    if ((flags & 0x01) === 0) {
      return {
        valid: false,
        code: 'PASSKEY_USER_PRESENCE_REQUIRED',
        error: 'Passkey assertion requires User Presence (UP) flag.',
      };
    }

    const signCount = authData.readUInt32BE(33);
    if (
      credential.sign_count > 0 &&
      signCount > 0 &&
      signCount <= credential.sign_count
    ) {
      return {
        valid: false,
        code: 'PASSKEY_CLONE_OR_REPLAY_DETECTED',
        error: 'Passkey signature counter did not advance (possible cloned authenticator).',
      };
    }

    const clientDataHash = crypto
      .createHash('sha256')
      .update(clientDataBytes)
      .digest();
    const signedPayload = Buffer.concat([authData, clientDataHash]);
    const signatureBytes = Buffer.from(assertion.signature_b64, 'base64url');

    try {
      const publicKey = crypto.createPublicKey(credential.public_key_pem);
      const isValid =
        credential.algorithm === 'EdDSA'
          ? crypto.verify(null, signedPayload, publicKey, signatureBytes)
          : crypto.verify('sha256', signedPayload, publicKey, signatureBytes);

      if (!isValid) {
        return {
          valid: false,
          code: 'PASSKEY_SIGNATURE_INVALID',
          error: 'Passkey cryptographic signature verification failed.',
        };
      }
    } catch {
      return {
        valid: false,
        code: 'PASSKEY_VERIFICATION_ERROR',
        error: 'Passkey cryptographic verification errored (fail-closed).',
      };
    }

    return {
      valid: true,
      new_sign_count: signCount,
    };
  }
}

export class PasskeyModuleRegistry {
  private readonly modules = new Map<string, PasskeyVerifierModule>();

  constructor(
    initialModules: PasskeyVerifierModule[] = [
      new WebAuthnPasskeyVerifier('ES256'),
      new WebAuthnPasskeyVerifier('EdDSA'),
    ],
  ) {
    for (const mod of initialModules) {
      this.modules.set(mod.algorithm, mod);
    }
  }

  register(mod: PasskeyVerifierModule): void {
    this.modules.set(mod.algorithm, mod);
  }

  get(algorithm: string): PasskeyVerifierModule | null {
    return this.modules.get(algorithm) ?? null;
  }
}
