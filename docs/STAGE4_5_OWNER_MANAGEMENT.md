# TEJAURA Stage 4.5 — Owner Management Center & Authentication Repair

## Part 1 — Authentication Root-Cause Audit & Fixes

### Identified Root Causes in Pre-Stage-4.5 Sign-In Flow
1. **`__Host-` Cookie Blocking in Cross-Site Iframe & Localhost HTTP Dev**:
   - The previous implementation unconditionally emitted `__Host-tejaura_session=...; Path=/; HttpOnly; SameSite=Strict; Secure`.
   - When accessing the Vite/Express preview via `http://localhost:3000` / `http://127.0.0.1:3000`, browsers reject `Secure` cookies over plain HTTP unless running on HTTPS, leaving login requests apparently succeeding while subsequent `/api/system/overview` calls failed with HTTP `401`.
   - When opened inside a cloud IDE / AI Studio cross-site preview `<iframe>`, `SameSite=Strict` blocks sending the session cookie back on subsequent fetches.
2. **Multi-Hop Reverse-Proxy `X-Forwarded-Host` Splitting in CSRF Guard**:
   - Reverse proxies frequently send comma-separated values in `X-Forwarded-Host` (e.g. `preview.example.com, internal.gateway`). Comparing raw `Origin` host against an unsplit `X-Forwarded-Host` string rejected valid state-changing requests (`POST /api/auth/login`, `/api/agents`, etc.) with `CSRF_ORIGIN_MISMATCH`.
3. **TOTP Whitespace Sensitivity**:
   - Users pasting 6-digit authenticator codes formatted with spaces (`"123 456"`) failed verification because internal whitespace wasn't stripped before matching `/^\d{6}$/`.
4. **Blind Post-Login State Transition**:
   - `AuthScreen` called `onAuthenticated` immediately after `POST /api/auth/login` without verifying that the browser actually persisted and sent back the `HttpOnly` cookie, causing cascading `401` errors across dashboard views.

### Implemented Security-Preserving Architecture
`resolveSessionTransportMode` in `core/auth/session-manager.ts` selects one of three strict transport modes:
- **`https_direct`** (default HTTPS top-level access): `__Host-tejaura_session`, `HttpOnly; Secure; SameSite=Strict; Path=/`.
- **`https_embedded_iframe`** (detected via `Sec-Fetch-Dest: iframe` or `Sec-Fetch-Site: cross-site` over HTTPS): `__Host-tejaura_session`, `HttpOnly; Secure; SameSite=None; Partitioned; Path=/` (CHIPS partitioned cookie).
- **`http_loopback_dev`** (strictly restricted to `development` environment AND loopback `localhost` / `127.0.0.1` / `[::1]`): `tejaura_dev_session`, `HttpOnly; SameSite=Lax; Path=/`.
- **Fail-Closed Guarantee**: Plaintext HTTP on non-loopback hosts or in `production` mode continues to fail closed with `426 HTTPS_REQUIRED`.

Both cookie names (`__Host-tejaura_session` and `tejaura_dev_session` in loopback dev only) are parsed consistently on authentication and cleared cleanly on logout / revoke-all.

`AuthScreen` immediately verifies `/api/auth/status` right after `POST /api/auth/login`; if a third-party iframe blocks cookies, it displays explicit guidance to open the TEJAURA URL directly in a standalone browser tab.

---

## Part 2 & 3 — SQLite Schema v3 & Owner Management Modules

SQLite migration `v3` (`003_stage45_management_center`) persists:
- `managed_agents` (with SQL `CHECK` constraint enforcing `permitted_autonomy_level IN ('L0','L1','L2','L3')` — `L4` permanently forbidden)
- `managed_models` (with `source` supporting `modelscope`, `huggingface`, `local_mirror`, `owner_archive`; `size_mb`, `format`, `install_status`, `verified_on_disk`, `is_default`, `is_backup`)
- `managed_workers` (endpoint URL validated via SSRF guard, `auth_token_env_var` references only — raw tokens strictly rejected)
- `managed_projects` (assigned agents, change history, error log, deployment status, `pending_approval_id`)
- `system_config_kv` (`maintenance_mode`, `max_queue_depth`, `auto_recover_leases`, `preferred_model_source`, `default_model_id`, `backup_model_id`)
- `system_backups` (confined `<stateDir>/backups/<id>.json` snapshots with SHA-256 checksum verification)

### Owner Management APIs
- **Owner Profile & Auth**: `GET/PATCH /api/auth/profile`, `POST /api/auth/password`, `GET /api/auth/sessions`, `POST /api/auth/sessions/:id/revoke`, `POST /api/auth/sessions/revoke-others`, `GET /api/auth/mfa`, `POST /api/auth/mfa/:id/toggle`, `DELETE /api/auth/mfa/:id`, `POST /api/auth/recovery-codes/regenerate`
- **Agent Management**: `GET/POST /api/agents`, `PATCH /api/agents/:id`, `POST /api/agents/:id/status`, `GET /api/agents/:id/history`
- **Model Management**: `GET/POST /api/models`, `PATCH/DELETE /api/models/:id`, `POST /api/models/:id/toggle`, `POST /api/models/:id/role`, `POST /api/models/:id/verify-install`
- **Worker & Compute Management**: `GET/POST /api/workers`, `PATCH/DELETE /api/workers/:id`, `POST /api/workers/:id/toggle`, `POST /api/workers/:id/probe`
- **Project Management**: `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id`, `POST /api/projects/:id/deploy` (mandatory owner-approved `ApprovalService` gate for `staging` and `production` deployments)
- **System Administration**: `GET /api/system/admin`, `PATCH /api/system/config`, `GET /api/system/logs`, `GET/POST /api/system/backups`, `POST /api/system/backups/:id/restore`

---

## Part 4 — Stage 4.5 Security Audit Repairs

### Approval Integrity
- Removed fabricated owner identities and automatic approval decisions from runtime bootstrap and management flows. The control plane never decides an approval on the owner's behalf.
- Worker registration, toggle, and delete now create a single-use `runtime:manage` approval bound to the exact endpoint and `runtime:manage:approved` scope. The HTTP response is `202` with `requires_approval: true` and the pending approval record.
- Staging and production project deployments create a single-use `deploy:staging` / `deploy:production` approval bound to the project and target environment. The approval inbox decision endpoint performs the deployment after verifying the bound scope, environment, resource, reviewer, expiry, and single-use state.
- The `POST /api/tasks` route no longer accepts a client-supplied `owner_confirmed_l4` flag. L4 tasks always enter `waiting_for_approval`; execution requires a linked approval reviewed by the designated owner.
- Management UI actions surface the pending approval ID and retry with `approval_id` only after the owner approves in the Approval Inbox.

### Persistence and Secret Storage
- Startup rehydration of persisted models and worker endpoints uses dedicated restore paths that validate records without minting owner identities or approvals. Live mutations still require the full policy and approval path.
- Encrypted secret vault writes are atomic (`tmp` file + `rename`), restricted to `0600`, and reject malformed entries on load.
- Raw worker tokens remain environment-only; the management API and UI expose presence metadata and environment variable names, never token values.

### Test Coverage
`control-plane/tests/stage45-auth-and-management.test.ts` covers auth transport modes, CSRF, restarts, sessions, password rotation, MFA, recovery codes, agent L4 rejection, model registration/verification, worker SSRF/token/probe behavior, staging and production approval gates, backups, persistence, audit logs, and the L4 client-flag bypass regression.
