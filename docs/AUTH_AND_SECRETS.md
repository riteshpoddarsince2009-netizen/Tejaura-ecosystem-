# TEJAURA Stage 2B — Private Identity, Authentication & Secrets Architecture

**Document Version:** 1.0.0  
**Implementation Status:** Implemented & Automated-Test Verified *(Local Control-Plane Web UI & Production Reverse-Proxy TLS Termination Pending Stage 3 / Deployment)*

---

## 1. Overview & Separation of Concerns

TEJAURA Stage 2B introduces an independent, owner-controlled identity, session, RBAC, and secrets management foundation without relying on external SaaS auth providers or paid APIs.

| Module | Path | Responsibility |
| :--- | :--- | :--- |
| **Security Schemas & Crypto** | `core/security/` | Draft 2020-12 config/store schemas, Argon2id hashing, AES-256-GCM encryption at rest, HTTPS enforcement |
| **Authentication & Sessions** | `core/auth/` | Once-only owner setup, username/email + password login, sliding-window rate limiter, `HttpOnly`/`Secure`/`SameSite` cookies, session expiry/logout/revocation, extensible MFA & passkeys, single-use account recovery, HTTP middleware |
| **RBAC & Governance Bridge** | `core/rbac/` | Default-deny RBAC (`owner`, `operator_readonly`, `agent_restricted`, `worker_service`), audited role assignments, `PolicyActor` & `TrustedReviewerContext` bridges |
| **Secrets Management** | `core/secrets/` | Isolated `SecretsManager` (`EnvSecretProvider` + AES-256-GCM `EncryptedVaultBackend`), zero frontend/agent access, strict `TEJAURA_AIRLLM_WORKER_TOKEN` isolation |
| **Audit Logger Extensions** | `core/audit/` | Typed audit emitters for login, logout, failed auth, MFA/passkey, recovery, permission changes, and secret access (zero secret values logged) |

---

## 2. Independent Owner Identity & Argon2id Hashing

1. **Initial Setup (`setupInitialOwner`):**
   - Runs **once** (`OWNER_ALREADY_INITIALIZED` on repeat calls).
   - Enforces password length (`>= 14` default in production example; `>= 12` schema minimum) and character-class complexity (`>= 3` classes).
   - Rejects passwords matching `TEJAURA_AIRLLM_WORKER_TOKEN`.
   - Generates `8` high-entropy recovery codes, stores **only** Argon2id hashes (`$argon2id$`), and returns plaintext codes once for offline owner backup.
2. **Argon2id Configuration (`core/security/security-config.example.json`):**
   - `memoryCostKiB`: `65536` (64 MiB default; schema minimum `19456` KiB per OWASP).
   - `timeCost`: `3` iterations (schema minimum `2`).
   - `parallelism`: `1`.
   - `saltBytes`: `16` bytes CSPRNG per hash (`crypto.randomBytes`).
   - `hashLength`: `32` bytes.
   - Plaintext passwords are **never** stored, logged, or returned.
3. **Timing Side-Channel Mitigation:**
   - Unknown username/email logins still execute a dummy Argon2id verification against a cached process hash before returning generic `Invalid credentials.`.

---

## 3. Session Security, Cookies, Rate Limiting & HTTPS Enforcement

- **Opaque Session Tokens:** 32 random bytes (`base64url`) stored at rest **only** as SHA-256 hex digests (`token_hash`).
- **Strict Cookie Attributes:**
  - Cookie prefix: `__Host-tejaura_session` (prevents subdomain cookie injection and forces `Path=/` + `Secure` in browsers).
  - Flags enforced by schema (`const: true`): `HttpOnly`, `Secure`, `SameSite=Strict` (or `Lax` if explicitly configured), `Path=/`.
- **Lifecycle Controls:**
  - Absolute `ttlSeconds` (default 8h) and `idleTimeoutSeconds` (default 1h) refreshed on verified requests.
  - Bounded `maxActiveSessionsPerOwner` (evicts oldest active session).
  - Explicit `logout`, `revokeSession`, and `revokeAllSessions`.
- **Login & Recovery Rate Limiting (`LoginRateLimiter`):**
  - Sliding-window counter keyed across normalized `identifier`, `clientIp`, and `(clientIp, identifier)`.
  - Locks out after `maxAttempts` failures (`5` default in `900s`) for `lockoutSeconds` (`900s`).
- **HTTPS Transport Enforcement (`enforceHttpsTransport`):**
  - Rejects plaintext HTTP (`426 HTTPS_REQUIRED`) in `production` and `staging` deployments even on `127.0.0.1` unless `req.secure` / TLS socket / trusted `x-forwarded-proto: https` is present.
  - Loopback `http://127.0.0.1` / `localhost` is allowed **only** when `environment` is `local`/`sandbox`/`development`/`test` AND `allowLocalLoopbackHttpInDev: true`.

---

## 4. Extensible MFA & Passkey Modules

- **MFA Registry (`MfaModuleRegistry` / `MfaChallengeModule`):**
  - Ships with `TotpMfaModule` (RFC 6238 6-digit TOTP, AES-256-GCM encrypted base32 secret bound with AAD `mfa:<factor_id>:totp`, and `last_used_step` monotonic replay protection).
  - New MFA modules can be registered cleanly via `MfaModuleRegistry.register(module)`.
  - When any MFA factor is enrolled and `requireMfaWhenEnrolled: true`, password login fails closed (`MFA_CODE_REQUIRED`) without a valid second factor.
- **Passkey Registry (`PasskeyModuleRegistry` / `PasskeyVerifierModule`):**
  - Ships with `WebAuthnPasskeyVerifier` supporting `ES256` (ECDSA P-256) and `EdDSA`.
  - Enforces single-use server-issued challenges (`issuePasskeyChallenge`), `type === "webauthn.get"`, origin match, RP ID SHA-256 hash match, User Presence (`UP`) flag bit, signature verification, and monotonic `sign_count` anti-cloning checks.

---

## 5. Secure Account Recovery

- `recoverAccount` verifies username/email + a single-use recovery code against stored Argon2id hashes under strict rate limiting.
- Upon success:
  1. Consumes that recovery code (`used_at` timestamp).
  2. Validates and Argon2id-hashes the new password (checking distinctness from `TEJAURA_AIRLLM_WORKER_TOKEN`).
  3. **Revokes all active sessions** (`revokeAllForActor`).
  4. Never exposes prior passwords, secrets, or unconsumed recovery codes.

---

## 6. Secrets Management & `TEJAURA_AIRLLM_WORKER_TOKEN` Separation

- `SecretsManager` (`core/secrets/`) is completely separated from owner authentication and configuration files:
  - `EnvSecretProvider`: reads explicitly allowlisted environment variables (default: `TEJAURA_AIRLLM_WORKER_TOKEN`).
  - `FileEncryptedVaultBackend` / `InMemoryEncryptedVaultBackend`: encrypts stored credentials with **AES-256-GCM** using HKDF-SHA256 derived keys from `TEJAURA_SECRETS_MASTER_KEY` and AAD bound to `secret:<key>:<scope>`. Refuses web-served directories (`src/`, `public/`, `dist/`, `build/`, `static/`, `www/`).
- **Zero Exposure Guarantees:**
  - `agent_restricted` and `actor_type === 'agent'` are unconditionally blocked from `secrets:read`, `secrets:write`, and `worker:airllm:token`.
  - Frontend code (`src/`) receives zero secrets and zero `.env` credentials.
  - `listMetadata()` returns only key names, sources, scopes, and presence booleans.
  - `TEJAURA_AIRLLM_WORKER_TOKEN` remains scoped exclusively to the internal TypeScript-to-Python AirLLM worker control plane (`X-TEJAURA-Worker-Token`) and is forbidden as an owner password.

---

## 7. RBAC, Default-Deny & Owner Approval Preservation

| Role | Intended Actor | Permitted Capabilities | Denied Capabilities |
| :--- | :--- | :--- | :--- |
| `owner` | Human owner (authenticated session) | Full `L4` governance, approvals, auth/MFA admin, RBAC, secrets, registry | — |
| `operator_readonly` | Human read-only inspector | `governance:read`, `model:discover:local`, `secrets:inventory` (names only), `audit:read` | Approvals, mutations, secret values, auth/RBAC admin |
| `agent_restricted` | Bounded AI agents (`L0`–`L2`) | `workspace:read`, `proposal:draft`, `sandbox:write`, `sandbox:execute`, `model:invoke_local` | **All** approvals, `L4` actions, `secrets:*`, `auth:*`, `rbac:manage`, `worker:airllm:token` |
| `worker_service` | Internal runtime adapter | `worker:airllm:token`, `model:discover:local` | Owner approvals, governance, RBAC, external credentials |

Verified owner sessions produce `PolicyActor` (`L4`, `trusted_authenticated: true`) and `TrustedReviewerContext` (`authenticated: true`, `auth_source: 'tejaura-owner-session'`), preserving strict human-only `L3`/`L4` approval enforcement inside `PolicyEvaluator` and `ApprovalService`.
