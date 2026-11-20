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
  SessionManager,
  buildClearSessionCookieHeader,
  buildSessionSetCookieHeader,
  parseSessionTokenFromCookieHeader,
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
  MfaVerificationResult,
  PasskeyAssertionPayload,
  PasskeyVerificationInput,
  PasskeyVerificationResult,
  PasskeyVerifierModule,
  RecoverAccountInput,
} from './auth-types.ts';
