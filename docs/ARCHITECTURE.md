# TEJAURA Modular System Architecture

**Document Version:** 1.4.0  
**Implementation Status:** Stage 3 — Governance, Contracts, Policy Engine, AirLLM-Primary Local Model Infrastructure, Private Identity/Auth/RBAC/Secrets, Persistent SQLite Orchestrator, Control Plane HTTP API, and Phone-First Owner Control Plane UI Implemented (Pre-Alpha). Sandboxed `L2` task plugins (`Stage 4`) and autonomous agent loops (`Stage 5`) remain **planned**.

---

## 1. Architectural Philosophy

TEJAURA is structured as a layered, modular operating system where **governance sits above intelligence**, and **execution sits behind explicit policy gates**:

- **Governance First:** No execution or orchestration path operates without consulting `core/` policies, RBAC, and approvals.
- **Phone as Control Device, Compute on Owner Nodes:** The Android phone browser (`src/`) is the owner's control surface for inspection, approvals, scheduling, and task dispatch. Open-weight inference runs on owner-controlled local or remote compute nodes.
- **AirLLM Primary Engine, Zero Paid Fallback:** AirLLM (`workers/airllm/`) is TEJAURA's primary model inference engine for compatible open-weight text models, supported alongside secondary local adapters (Ollama, llama.cpp, vLLM, SGLang, OpenAI-compatible local servers). Paid third-party AI APIs are disabled and blocked.
- **Strict Trust Boundaries:** The React frontend communicates solely via `HttpOnly` cookie sessions + `X-TEJAURA-CSRF: 1` over same-origin `/api/*` routes. Master keys, recovery hashes, and `TEJAURA_AIRLLM_WORKER_TOKEN` never leave the server process.

---

## 2. System Layer Overview

```text
+-------------------------------------------------------------------+
|       4. PHONE-FIRST OWNER CONTROL PLANE UI (Implemented - Stg 3) |
|   React SPA (375px Mobile + Desktop): Auth | Overview | Tasks     |
|   Approval Inbox | Schedules | Models & Probe | Policy | Audit    |
+-------------------------------------------------------------------+
                                  |  (HttpOnly Cookie + X-TEJAURA-CSRF)
                                  v
+-------------------------------------------------------------------+
|   3. PERSISTENT CONTROL PLANE & ORCHESTRATOR (Implemented - Stg 3)|
|   control-plane/server/: Auth Middleware, CSRF, Rate Limit, 64KB  |
|   control-plane/orchestrator/: Leases, Retries, Schedules, Worker |
|   control-plane/db/: Schema-Migrated SQLite WAL Persistence       |
+-------------------------------------------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|   1. CORE GOVERNANCE, IDENTITY & SECURITY (Stages 1 & 2B)         |
|   Owner Auth (Argon2id, HttpOnly/Secure Cookies, MFA/Passkeys)    |
|   Default-Deny RBAC | Encrypted Secrets Vault | System Validator  |
|   Policy Evaluator  | Approval Gatekeeper     | Audit Logger      |
+-------------------------------------------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|   2. LOCAL INTELLIGENCE & RUNTIME ROUTING (Implemented - Stage 2A)|
|   Local Model Registry (verified-only) | Hardware Fit Checker     |
|   Model Lifecycle & Circuit Breaker    | Model Router (no paid)   |
|   RuntimeManager (AirLLM Primary + Ollama/llama.cpp/vLLM/SGLang)  |
+-------------------------------------------------------------------+
                                  |  (X-TEJAURA-Worker-Token / HTTPS or 127.0.0.1)
                                  v
+-------------------------------------------------------------------+
|     5. ISOLATED PYTHON AIRLLM WORKER (Implemented - Stage 2A)     |
|   workers/airllm/: Authenticated HTTP Control Plane               |
|   RealAirLlmEngine (airllm.AutoModel - lazy) | MockAirLlmEngine   |
+-------------------------------------------------------------------+
```

---

## 3. Module Responsibilities & Verification Status

### 3.1 `core/` & `contracts/` *(Implemented & Automated-Test Verified)*
- **`contracts/`:** JSON Schema Draft 2020-12 contracts (`task`, `agent`, `tool`, `approval`, `audit-event`), TypeScript types, and fail-closed Ajv validator.
- **`core/constitution/`, `core/identity/`, `core/permissions/`, `core/configuration/`:** Constitutional rules, `L0`–`L4` autonomy levels, non-self-approval policy, and `system.json` validation.
- **`core/security/`, `core/auth/`, `core/rbac/`, `core/secrets/`:** Argon2id identity & sessions, `HttpOnly`/`Secure`/`SameSite` cookies, TOTP MFA & WebAuthn passkeys, single-use recovery, default-deny RBAC, and AES-256-GCM encrypted `SecretsManager`.
- **`core/policy/`, `core/approvals/`, `core/audit/`:** Fail-closed Policy Evaluator, single-use owner Approval Gatekeeper, and append-only JSONL Audit Logger.

### 3.2 `intelligence/` & `workers/airllm/` *(Implemented & Mock-Verified)*
- **`intelligence/`:** Draft 2020-12 Local Model Registry, `HardwareManager`, `RuntimeManager` with `AirLlmRuntimeAdapter` primary + secondary local runtimes, `ModelLifecycleManager`, and `ModelRouter`.
- **`workers/airllm/`:** Authenticated Python HTTP worker (`MockAirLlmEngine` automated-test verified; `RealAirLlmEngine` physical GPU inference pending hardware verification).

### 3.3 `control-plane/`, `server.ts` & `src/` *(Implemented & Automated-Test Verified — Stage 3)*
- **`control-plane/db/`:** Schema-migrated SQLite store (`node:sqlite`, WAL mode) persisting tasks, task events, execution attempts, leases, schedules, and approvals outside public web roots.
- **`control-plane/orchestrator/`:** Priority task queue, idempotency deduplication, bounded concurrency/leases, crash lease recovery, `AbortSignal` timeouts/cancellation, recurring schedule triggers, and non-idempotent retry blocks (`NON_IDEMPOTENT_CONFIRMATION_REQUIRED`).
- **`control-plane/server/` & `server.ts`:** Express control-plane HTTP API integrated with Stage 2B auth/RBAC/secrets/audit, CSRF protection, sliding-window rate limiting, and Vite dev / static production hosting on port `3000`.
- **`src/`:** Mobile-first React + Tailwind control plane UI covering all owner authentication, task, approval, scheduling, model probing, policy inspection, audit trail, and security management views.

### 3.4 Sandboxed Execution Plugins *(Planned — Stage 4+)*
- Sandboxed `L2` task plugins with workspace path allowlists and dry-run diffs remain **not yet implemented**.

---

## 4. Non-Negotiable Security Boundaries

- **Zero Secrets in Source, Registry, or Frontend:** Server-only secrets (`TEJAURA_SECRETS_MASTER_KEY`, `TEJAURA_AIRLLM_WORKER_TOKEN`, vault ciphertexts, password hashes) never appear in API payloads, audit logs, or React/browser storage.
- **Untrusted Model Output:** Completions carry `untrusted_model_output: true` and cannot alter permissions, endpoints, registry entries, or `system.json`.
- **No Agent Self-Approval or L4 Autonomy:** `ApprovalService` enforces designated-owner identity (`bindDesignatedOwnerId`) and rejects `requested_by === reviewer.actor_id`.
- **Zero Paid Third-Party AI APIs:** Commercial API hosts are blocked at endpoint validation and omitted from all fallback paths.
