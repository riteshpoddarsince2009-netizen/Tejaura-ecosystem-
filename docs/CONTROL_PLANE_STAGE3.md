# TEJAURA Stage 3 — Phone-First Owner Control Plane

**Scope:** Persistent task orchestration (`control-plane/db/`, `control-plane/orchestrator/`), authenticated control plane API (`control-plane/server/`, `server.ts`), and responsive mobile-first owner UI (`src/`).  
**Status:** Implemented & Automated-Test Verified (`control-plane/tests/`). Not yet physically QA-tested on Android hardware behind a production HTTPS reverse proxy.

---

## 1. Architecture Summary

1. **SQLite Persistence (`control-plane/db/sqlite-store.ts`, `migrations.ts`)**
   - Uses Node.js built-in `node:sqlite` (`DatabaseSync`) with WAL mode and schema version tracking (`schema_migrations`).
   - Enforces non-public state directory checks so database and vault files are never placed under `public/`, `dist/`, `src/`, `static/`, or `www/`.
   - Stores `tasks`, `task_events`, `execution_attempts`, `schedules`, and `approvals` with transactional state transitions.

2. **Governed Task Orchestration (`control-plane/orchestrator/task-orchestrator.ts`)**
   - Every submitted task passes contract validation (`validateTask`) and Stage 1 `evaluatePolicyWithAudit` before queueing.
   - `L3` / `L4` approval-gated tasks enter `waiting_for_approval` and create a pending single-use approval record bound to the task and environment.
   - Worker execution uses bounded concurrency (`maxConcurrentRunning`), timed leases (`leaseDurationMs`), `AbortSignal` timeouts/cancellation, and `recoverAbandonedLeases()`.
   - Non-idempotent external tasks that dispatched an effect (`external_effect_dispatched === true`) block automatic retries and require explicit owner confirmation (`NON_IDEMPOTENT_CONFIRMATION_REQUIRED`) before manual retry.

3. **Authenticated HTTP Control Plane (`control-plane/server/create-control-plane-app.ts`)**
   - Protected routes enforce Stage 2B session cookies (`__Host-tejaura_session` with `HttpOnly; Secure; SameSite=Strict`), production HTTPS checks (`426 HTTPS_REQUIRED`), default-deny RBAC, `X-TEJAURA-CSRF: 1` + Origin/Referer matching (`403`), `64KB` JSON limits (`413`), and sliding-window API rate limits (`429`).
   - `/api/system/overview` exposes non-sensitive secret presence metadata only (`key`, `source`, `scope`, `present`, `updated_at`), never secret values.

4. **Phone-First Control Plane UI (`src/`)**
   - Styled with `#030712` background, `#6366F1` primary indigo, `#06B6D4` secondary cyan, `>= 44px` mobile touch targets, compact mobile top/bottom navigation, and `240px` desktop sidebar.
   - Covers Auth/Setup/Recovery, Overview, Task Center, Approval Inbox (required reason + 2-step confirmation), Schedules, Model & Runtime Center (`Probe Availability`), Read-Only Policy Inspector, Read-Only Audit Center, and Settings & Security.

---

## 2. Known Limitations & Remaining Manual Checks

- **Sandboxed `L2` Task Plugins (Stage 4):** Only recognized catalog actions with built-in/registered handlers (`governance:read`, `model:discover`, `model:invoke_local`, `proposal:draft`, or registered `externalHandlers`) can execute to completion; unimplemented catalog actions fail closed with `NO_HANDLER_FOR_ACTION`.
- **TLS Termination:** In production (`NODE_ENV=production`), place TEJAURA behind a trusted TLS reverse proxy setting `X-Forwarded-Proto: https` (or configure TLS directly) because plain HTTP requests fail closed with `426`.
- **Single-Node SQLite:** Designed for single-owner host deployment; multi-node horizontal worker locking is out of scope for Stage 3.
- **Physical Device Verification:** Mobile touch ergonomics (`375px`) and browser rendering were verified via build/render tests; live manual QA on a physical Android browser and physical AirLLM GPU inference remain owner verification steps.
