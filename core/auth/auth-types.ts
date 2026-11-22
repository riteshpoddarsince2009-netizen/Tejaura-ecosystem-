import type { ExecutionEnvironment } from '../../contracts/types/index.ts';
import type { TrustedReviewerContext } from '../approvals/index.ts';
import type { PolicyActor } from '../policy/index.ts';
import type { RbacPrincipal } from '../rbac/index.ts';
import type {
  IdentityStoreSnapshot,
  StoredMfaFactor,
  StoredPasskeyCredential,
  TejauraRole,
} from '../security/index.ts';

export type SessionTransportMode =
  | 'https_direct'
  | 'https_embedded_iframe'
  | 'http_loopback_dev';

export interface AuthRequestContext {
  protocol?: string;
  encrypted?: boolean;
  host?: string;
  forwardedProto?: string;
  forwardedHost?: string;
  clientIp?: string;
  userAgent?: string;
  origin?: string;
  secFetchSite?: string;
  secFetchDest?: string;
  environment?: ExecutionEnvironment | 'development' | 'test';
}

export interface InitialOwnerSetupInput {
  owner_id: string;
  username: string;
  email: string;
  password: string;
  display_name?: string;
  timezone?: string;
  correlation_id: string;
  request?: AuthRequestContext;
}

export interface InitialOwnerSetupResult {
  ok: true;
  owner_id: string;
  username: string;
  recovery_codes: string[];
}

export interface LoginInput {
  identifier: string; // username or email
  password: string;
  mfa_code?: string;
  mfa_factor_id?: string;
  correlation_id: string;
  request?: AuthRequestContext;
}

export interface AuthenticatedSessionContext {
  session_id: string;
  owner_id: string;
  username: string;
  role: TejauraRole;
  expires_at: string;
  idle_expires_at: string;
  toPrincipal: () => RbacPrincipal;
  toPolicyActor: () => PolicyActor;
  toTrustedReviewerContext: () => TrustedReviewerContext;
}

export interface LoginSuccessResult {
  ok: true;
  session: AuthenticatedSessionContext;
  set_cookie_header: string;
  transport_mode: SessionTransportMode;
}

export interface AuthFailureResult {
  ok: false;
  code: string;
  error: string;
  mfa_required?: boolean;
  retry_after_seconds?: number;
}

export interface OwnerProfileSummary {
  owner_id: string;
  username: string;
  email: string;
  display_name: string;
  timezone: string;
  role: 'owner';
  created_at: string;
  updated_at: string;
  mfa_enabled_count: number;
  passkeys_count: number;
  recovery_codes_total: number;
  recovery_codes_remaining: number;
}

export interface MfaFactorSummary {
  factor_id: string;
  type: 'totp' | 'custom';
  label: string;
  enabled: boolean;
  enrolled_at: string;
  last_used_step: number | null;
}

export interface ActiveSessionSummary {
  session_id: string;
  actor_id: string;
  role: TejauraRole;
  created_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  expires_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  is_current: boolean;
  client_ip: string | null;
  user_agent: string | null;
}

export interface RecoverAccountInput {
  identifier: string;
  recovery_code: string;
  new_password: string;
  correlation_id: string;
  request?: AuthRequestContext;
}

export interface MfaEnrollmentResult {
  ok: true;
  factor_id: string;
  type: 'totp' | 'custom';
  otpauth_uri?: string;
  provisioning_secret?: string;
}

export interface MfaChallengeVerificationInput {
  factor: StoredMfaFactor;
  code: string;
  now: Date;
  masterKey: Buffer;
}

export type MfaVerificationResult =
  | { valid: true; next_used_step?: number }
  | { valid: false; code: string; error: string };

export interface MfaChallengeModule {
  readonly type: 'totp' | 'custom';
  verifyChallenge(input: MfaChallengeVerificationInput): Promise<MfaVerificationResult> | MfaVerificationResult;
}

export interface PasskeyAssertionPayload {
  credential_id: string;
  challenge: string;
  clientDataJSON_b64: string;
  authenticatorData_b64: string;
  signature_b64: string;
}

export interface PasskeyVerificationInput {
  credential: StoredPasskeyCredential;
  assertion: PasskeyAssertionPayload;
  expectedOrigin: string;
}

export type PasskeyVerificationResult =
  | { valid: true; new_sign_count: number }
  | { valid: false; code: string; error: string };

export interface PasskeyVerifierModule {
  readonly algorithm: StoredPasskeyCredential['algorithm'];
  verifyAssertion(
    input: PasskeyVerificationInput,
  ): Promise<PasskeyVerificationResult> | PasskeyVerificationResult;
}

export interface IdentityStoreBackend {
  load(): IdentityStoreSnapshot;
  save(snapshot: IdentityStoreSnapshot): void;
}
