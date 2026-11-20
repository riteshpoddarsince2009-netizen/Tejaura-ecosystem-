# TEJAURA Security Model (Stage 1)

**Document Version:** 1.0.0  
**Scope:** Configuration Validation, Policy Evaluator, Approval Gatekeeper, and Append-Only Audit Logger.

---

## 1. Security Objectives

1. **Human Owner Sovereignty:** Only the designated human owner may authorize `L3` supervised actions or execute `L4` owner-exclusive operations.
2. **Fail-Closed by Default:** Invalid configurations, missing identities, missing scopes, unknown actions, expired/mismatched approvals, and audit write failures all resolve to `deny` (`allowed: false`).
3. **Zero Privilege Self-Escalation:** Agents cannot hold `L4` autonomy, cannot grant permissions, cannot modify governance configs, and cannot approve their own requests.
4. **Zero Secrets in Source, Config, or Logs:** Schemas and sanitizers reject secret-like keys and raw credentials in configs, contracts, model registries, and JSONL audit logs.

---

## 2. Trust Boundaries

| Boundary | Trusted Inputs | Untrusted / Prohibited |
| :--- | :--- | :--- |
| **Authentication (External)** | Host/session layer provides `TrustedReviewerContext` (`authenticated: true`, `auth_source`) and `actor.trusted_authenticated`. | Approval records themselves are **not** proof of identity. Stage 1 intentionally includes no fabricated login system. |
| **Actor Autonomy & Scopes** | Host resolves `trusted_autonomy_level`, `trusted_agent_record`, and `declared_scopes` from owner-managed policy/store. | Agent-supplied claims requesting higher autonomy or broader scopes are never trusted. |
| **Configuration & Registry** | `system.json` and `models.json` validated strictly via Draft 2020-12 schemas before use. | Invalid configs never fall back to permissive defaults. |
| **Audit Persistence** | `AuditStorage` confined outside public web directories (`public/`, `dist/`, `src/`). | Authorization never proceeds (`allow`) if audit logging fails in `evaluatePolicyWithAudit`. |

---

## 3. Threat Assumptions

- **Compromised or Misbehaving Agent Prompt/Output:** An agent may attempt to invoke `deploy:production`, `permission:grant`, `approval:decide`, wildcard scopes (`*`), or pass self-signed `Approval` objects. All are blocked deterministically by schema constraints, `PolicyEvaluator`, and `ApprovalService`.
- **Replay or Cross-Scope Reuse of Approvals:** An approved `Approval` for `staging` or `resource-A` might be replayed against `production`, `resource-B`, or twice for a `single_use: true` action. Blocked by exact binding checks and `consumed_at` tracking.
- **Accidental Secret Leakage:** Callers might pass API keys or bearer tokens inside `metadata`, `input`, or `models.json`. Blocked by `model-registry.schema.json` / contract schemas and stripped by `AuditLogger`.

---

## 4. Approval Lifecycle & Failure Behavior

1. **Request (`pending`):** Created with explicit `task_id`, `action`, `environment`, `scope` (no wildcards), and optional future `expires_at`.
2. **Decision (`pending -> approved | rejected | expired`):** Only `designatedOwnerId` with `authenticated: true` and `actor_id !== requested_by` may transition `pending` to `approved` or `rejected`. Terminal states reject further transitions.
3. **Verification & Consumption:** Before `L3` execution, `verifyAndConsumeApproval` checks status, owner reviewer, task/action/environment/resource/scope match, clock expiration, and `single_use` consumption.
4. **Failure Modes:** Malformed inputs, JSON parse errors, schema compilation errors, or storage errors return structured failure objects (`allowed: false` / `ok: false`) without throwing unhandled exceptions or permitting execution.

---

## 5. Known Security Limitations & Stage 2B Updates

> **Stage 2B Update:** Built-in independent owner authentication (Argon2id, `HttpOnly`/`Secure`/`SameSite` sessions, rate limiting, extensible MFA/passkeys, single-use recovery), AES-256-GCM encrypted persistence (`identity.enc.json`, `secrets.vault.json`), default-deny RBAC, and isolated `SecretsManager` are now implemented and documented in [AUTH_AND_SECRETS.md](AUTH_AND_SECRETS.md) and [THREAT_MODEL.md](THREAT_MODEL.md).

1. **Local JSONL Audit Logs Are Not Tamper-Proof:** `JsonlAuditStorage` uses append-only writes (`O_APPEND`) and `0600` file modes, which protect against accidental overwrites and web exposure, **not** against a privileged OS user or compromised host altering local files. Cryptographic hash-chaining or remote WORM anchoring is deferred to later hardening stages.
2. **Host Key Injection & Memory Residency:** Stage 2B uses AES-256-GCM at rest keyed from `TEJAURA_SECRETS_MASTER_KEY`; hardware-backed KMS/HSM sealing is deferred to later hardening stages.
3. **In-Memory Approval & Rate-Limit Stores:** `InMemoryApprovalStore` and `LoginRateLimiter` do not persist across process restarts.
4. **No Process Sandboxing Yet:** `PolicyEvaluator` enforces `L2` sandbox policy decisions, while OS/container process isolation (`Stage 4`) is not yet implemented.
