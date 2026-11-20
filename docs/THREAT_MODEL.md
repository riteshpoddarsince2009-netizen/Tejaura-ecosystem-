# TEJAURA Stage 2B Security Threat Model

**Document Version:** 1.0.0  
**Scope:** Owner Identity, Session Management, MFA/Passkeys, Account Recovery, RBAC, Secrets Management, AirLLM Worker Isolation, and Transport Security.

---

## 1. Protected Assets

| Asset | Sensitivity | Storage / Handling Mechanism |
| :--- | :--- | :--- |
| **Owner Password & Recovery Codes** | Critical | Never stored in plaintext; Argon2id hashed with per-record 16-byte random salts. |
| **Owner Session Tokens** | Critical | Delivered only via `__Host-` `HttpOnly; Secure; SameSite=Strict` cookies; only SHA-256 hash stored at rest. |
| **MFA Seeds & Vault Secrets** | Critical | Encrypted at rest via AES-256-GCM with HKDF-SHA256 derived keys and AAD binding. |
| **`TEJAURA_AIRLLM_WORKER_TOKEN`** | High | Environment/vault scoped strictly to `worker_service` / `owner`; isolated from owner login and agents. |
| **Approval & Policy Authority (`L3`/`L4`)** | Critical | Bound to verified `owner` session -> `PolicyActor` / `TrustedReviewerContext`. |
| **Security Audit Trail** | High | Append-only JSONL with secret-key stripping and `0600` confinement outside web directories. |

---

## 2. Threat Matrix & Mitigations

| Threat | Vector | Implemented Mitigation | Status |
| :--- | :--- | :--- | :--- |
| **Credential Stuffing & Brute Force** | Repeated password or recovery-code guesses | Sliding-window `LoginRateLimiter` across IP + identifier + pair with lockout (`900s`), Argon2id memory-hard hashing (`>= 19 MiB` min, `64 MiB` prod example), and dummy-hash timing equalization on unknown identifiers. | Implemented & Tested |
| **Session Hijacking / XSS Token Theft** | JavaScript `document.cookie` exfiltration or insecure HTTP sniffing | `HttpOnly` + `Secure` + `__Host-` cookie prefix + `SameSite=Strict` + `Cache-Control: no-store` + HTTPS enforcement + opaque 256-bit tokens hashed with SHA-256 at rest. | Implemented & Tested |
| **CSRF on State-Changing Endpoints** | Cross-site POST from malicious tab | `SameSite=Strict` cookie attribute + Origin/Host verification in `createRequireOwnerAuthMiddleware`. | Implemented (Middleware) |
| **Stale / Compromised Session Persistence** | Unattended mobile device or password reset after compromise | Short idle timeout (`3600s`), absolute TTL (`28800s`), bounded concurrent sessions, single/bulk revocation, and automatic full-session revocation on account recovery. | Implemented & Tested |
| **MFA / Passkey Replay or Cloning** | Reusing 6-digit TOTP code or cloned hardware authenticator | TOTP `last_used_step` tracking rejects same/older steps; WebAuthn verifies single-use challenge, RP ID hash, origin, UP bit, signature, and monotonic `sign_count`. | Implemented & Tested |
| **Agent Secret Exfiltration & Prompt Injection** | Compromised model output or agent tool request reading `.env` or `TEJAURA_AIRLLM_WORKER_TOKEN` | Unconditional `AGENT_PRIVILEGED_PERMISSION_FORBIDDEN` & `AGENT_WORKER_TOKEN_FORBIDDEN` in RBAC & `SecretsManager`; all model outputs marked `untrusted_model_output: true`. | Implemented & Tested |
| **Privilege Escalation / Self-Approval** | Agent assigning itself `owner` role or approving `L3`/`L4` actions | `authorizeRbac`, `RbacRoleRegistry`, `PolicyEvaluator`, and `ApprovalService` all independently block `actor_type === 'agent'` and `agent*` IDs from `owner` role, `L4`, and approvals. | Implemented & Tested |
| **Plaintext Disk Leakage** | Reading local JSON store or `.env` snapshots | Whole-file AES-256-GCM encryption (`identity.enc.json`, `secrets.vault.json`), `0600` mode, web-directory refusal (`src/`, `public/`, `dist/`), and `identity-store.schema.json` `$argon2id$` regex enforcement. | Implemented & Tested |
| **Worker Token / Owner Password Confusion** | Owner reusing `TEJAURA_AIRLLM_WORKER_TOKEN` as login password or vice versa | Explicit equality check rejects setup/recovery passwords matching worker token; `SecretsManager` blocks `OWNER_PASSWORD*` keys. | Implemented & Tested |
| **Downgrade to Plaintext HTTP** | Deployment served over unencrypted `http://` | `enforceHttpsTransport` rejects HTTP in `production`/`staging` (`426 HTTPS_REQUIRED`); loopback HTTP allowed only in explicit dev/local mode. | Implemented & Tested |

---

## 3. Honest Residual Risks & Deployment Prerequisites

1. **Master Key Management (`TEJAURA_SECRETS_MASTER_KEY`):** Currently injected via environment variable (`process.env`). On a compromised host OS where an attacker already has root/user access to running process memory or `.env`, AES-256-GCM at-rest encryption protects cold disk files but cannot defend against live host compromise. Hardware-backed OS keychains or KMS/HSM sealing are deferred to later hardening stages.
2. **In-Memory Rate Limiter Across Multi-Process Restarts:** `LoginRateLimiter` state lives in memory for single-node control-plane deployments. Process restarts reset attempt counters unless backed by persistent/shared storage.
3. **Audit Log Integrity Against Privileged Host User:** As documented in `docs/SECURITY_MODEL.md`, local JSONL append-only writes (`O_APPEND`) do not provide cryptographic WORM / remote tamper-proof anchoring against root compromise.
4. **TLS Termination & Reverse Proxy Trust:** Deployment must place TEJAURA behind real TLS termination (Caddy/Nginx/Cloudflare/Tailscale HTTPS) and configure `trustProxyProtoHeader: false` if exposed directly without a trusted reverse proxy stripping spoofed `X-Forwarded-Proto` headers.
5. **Browser WebAuthn Registration Ceremony UI:** Server-side passkey challenge issuance and signature verification (`ES256`/`EdDSA`) are implemented and tested; Stage 3 will wire the browser `navigator.credentials` WebAuthn registration/assertion flow into the phone-first control-plane UI.
6. **Hardware AirLLM Inference Unverified:** As in Stage 2A, `RealAirLlmEngine` remains unverified on physical GPU/NVMe hardware until manual hardware-in-the-loop testing.
