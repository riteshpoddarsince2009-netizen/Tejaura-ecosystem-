export {
  EncryptedFileIdentityStoreBackend,
  InMemoryIdentityStoreBackend,
  TejauraAuthService,
} from './auth-service.ts';
export type { TejauraAuthServiceOptions } from './auth-service.ts';

export {
  MfaModuleRegistry,
  PasskeyModuleRegistry,
  TotpMfaModule,
  WebAuthnPasskeyVerifier,
  createEncryptedTotpFactor,
  decodeBase32,
  encodeBase32,
  generateTotpCode,
} from './mfa-passkey.ts';

export { LoginRateLimiter } from './rate-limiter.ts';
export type { RateLimitCheckResult } from './rate-limiter.ts';

export {
  DEV_LOOPBACK_COOKIE_NAME,
  SessionManager,
  buildClearSessionCookieHeader,
  buildSessionSetCookieHeader,
  parseSessionTokenFromCookieHeader,
  resolveSessionTransportMode,
} from './session-manager.ts';
export type {
  IssuedSession,
  SessionMetadataPayload,
} from './session-manager.ts';

export {
  applySecurityResponseHeaders,
  createRequireOwnerAuthMiddleware,
  extractAuthRequestContext,
  resolveCorrelationId,
} from './http-handlers.ts';
export type { TejauraAuthenticatedRequest } from './http-handlers.ts';

export type {
  ActiveSessionSummary,
  AuthFailureResult,
  AuthRequestContext,
  AuthenticatedSessionContext,
  IdentityStoreBackend,
  InitialOwnerSetupInput,
  InitialOwnerSetupResult,
  LoginInput,
  LoginSuccessResult,
  MfaChallengeModule,
  MfaChallengeVerificationInput,
  MfaEnrollmentResult,
  MfaFactorSummary,
  MfaVerificationResult,
  OwnerProfileSummary,
  PasskeyAssertionPayload,
  PasskeyVerificationInput,
  PasskeyVerificationResult,
  PasskeyVerifierModule,
  RecoverAccountInput,
  SessionTransportMode,
} from './auth-types.ts';
