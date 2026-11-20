# TEJAURA Modular System Architecture

**Document Version:** 1.3.0  
**Implementation Status:** Stage 2B — Governance, Contracts, Policy Engine, AirLLM-Primary Local Model Infrastructure, and Private Identity/Auth/RBAC/Secrets Foundation Implemented (Pre-Alpha). Control-plane UI (`Stage 3`), sandboxed task execution (`Stage 4`), and autonomous agents remain **planned**.

---

## 1. Architectural Philosophy

TEJAURA is structured as a layered, modular operating system where **governance sits above intelligence**, and **execution sits behind explicit policy gates**:

- **Governance First:** No execution layer can operate without consulting `core/` policies and configuration.
- **Phone as Control Device, Compute on Owner Nodes:** The Android phone is the owner's **control device** for inspection, approvals, and task dispatch—not the large-model inference machine. Large open-weight inference runs on owner-controlled local or remote compute nodes.
- **AirLLM Primary Engine, Zero Paid Fallback:** AirLLM (`workers/airllm/`) is TEJAURA's primary model inference engine for compatible open-weight text models, supported alongside secondary local runtimes (Ollama, llama.cpp, vLLM, SGLang, OpenAI-compatible local servers). TEJAURA never falls back to paid third-party AI APIs.
- **Strict Module Boundaries:** TypeScript governance/routing stays cleanly separated from Python AirLLM dependencies via an authenticated internal HTTP worker protocol.
- **Testability Without GPU or Model Weights:** Every governance, auth, RBAC, secrets, routing, lifecycle, and AirLLM protocol path is unit/integration-testable using deterministic mocks without downloading multi-GB weights.

---

## 2. System Layer Overview

```text
+-------------------------------------------------------------------+
|                   4. INTERFACES (Planned - Stage 3)               |
|   Android / Phone-First Control UI  |  Approval Inbox  |  CLI     |
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
|     3. ISOLATED PYTHON AIRLLM WORKER (Implemented - Stage 2A)     |
|   workers/airllm/: Authenticated HTTP Control Plane               |
|   RealAirLlmEngine (airllm.AutoModel - lazy) | MockAirLlmEngine   |
+-------------------------------------------------------------------+
```

---

## 3. Module Responsibilities & Verification Status

### 3.1 `core/` & `contracts/` *(Implemented & Tested)*
- **`contracts/`:** JSON Schema Draft 2020-12 contracts (`task`, `agent`, `tool`, `approval`, `audit-event`), TypeScript types, and fail-closed Ajv validator.
- **`core/constitution/`, `core/identity/`, `core/permissions/`:** Constitutional rules, `L0`–`L4` autonomy levels, and non-self-approval policy.
- **`core/configuration/`:** Draft 2020-12 `system.json` validator rejecting secrets and unsafe autonomy overrides.
- **`core/security/`:** Draft 2020-12 `security-config` & `identity-store` schemas/validators, Argon2id hashing, AES-256-GCM authenticated encryption, and HTTPS transport enforcement.
- **`core/auth/`:** Independent once-only owner setup, username/email login, sliding-window rate limiter, `HttpOnly`/`Secure`/`SameSite` session cookies, expiry/logout/revocation, extensible TOTP MFA & WebAuthn passkey modules, and single-use account recovery.
- **`core/rbac/`:** Default-deny RBAC (`owner`, `operator_readonly`, `agent_restricted`, `worker_service`) and `PolicyActor`/`TrustedReviewerContext` session bridges.
- **`core/secrets/`:** Isolated `SecretsManager` (`EnvSecretProvider` + AES-256-GCM vault) blocking agents/frontend and separating `TEJAURA_AIRLLM_WORKER_TOKEN` from owner auth.
- **`core/policy/`, `core/approvals/`, `core/audit/`:** Deterministic fail-closed Policy Evaluator, single-use human-owner Approval Gatekeeper, and append-only JSONL Audit Logger (with typed auth, permission-change, and secret-access emitters).

### 3.2 `intelligence/` *(Implemented & Mock-Tested — Stage 2A)*
- **`intelligence/model-registry/`:**
  - Stage 1 baseline (`models.json` / `model-registry.schema.json`) preserved.
  - Stage 2A local-first registry (`local-model.schema.json`, `local-models.json`, `local-model-registry.ts`) requiring `model_repository` (`repo_id`, `revision`, `source`), `compatibility_status` (`verified | untested | unsupported`), `modality`, `runtime_type`, `hardware_requirements`, `quantization`, `license`, and `local_model_path`. Only `verified` `text` models can be enabled.
- **`intelligence/hardware/`:** `ComputeNode` modeling and fail-closed `checkHardwareFit` (RAM, VRAM, storage, GPU, online status, runtime support).
- **`intelligence/runtime/`:** `RuntimeManager`, trusted endpoint allowlist (`endpoint-guard.ts`), `AirLlmRuntimeAdapter` (primary), and secondary adapters for Ollama, llama.cpp, vLLM, SGLang, and compatible servers.
- **`intelligence/lifecycle/` & `intelligence/router/`:** Availability probing, honest load/unload requests, bounded priority queue, concurrency caps, failure circuit breaker, and `ModelRouter` favoring `airllm` without paid API fallback.

### 3.3 `workers/airllm/` *(Implemented; Protocol Tested with Mock Engine — Live GPU Inference Not Yet Verified)*
- Runs separately from the TypeScript core on owner-controlled compute.
- Exposes authenticated `/internal/health`, `/internal/models`, `/internal/models/load`, `/internal/models/unload`, `/internal/infer`, and `/internal/requests/cancel`.
- **Tested:** Protocol auth, compatibility/modality rejection, load/infer/unload, timeouts, and cancellation against `MockAirLlmEngine`.
- **Not Yet Hardware-Verified:** Executing `RealAirLlmEngine` (`airllm.AutoModel`) end-to-end against downloaded model weights on physical GPU/NVMe hardware.

### 3.4 `interfaces/` & Sandboxed Execution *(Planned — Stage 3+)*
- Phone-first Android / mobile control-plane UI, owner approval inbox, and `L2` sandboxed task execution runtime are **not yet implemented**.

---

## 4. Non-Negotiable Security Boundaries

- **Zero Secrets in Source or Registry:** Worker authentication uses environment variable names (`auth_token_env_var` -> `TEJAURA_AIRLLM_WORKER_TOKEN`), never hardcoded tokens.
- **Untrusted Model Output:** All completions carry `untrusted_model_output: true` and cannot alter permissions, endpoints, registry entries, or `system.json`.
- **Explicit Compatibility & Modality Gates:** Untested, unsupported, or non-text (`image_generation`, unverified `multimodal_vision`, `audio`) models fail closed before dispatch.
- **Zero Paid Third-Party AI APIs:** Commercial API hosts are blocked at endpoint validation and omitted from all fallback paths.
