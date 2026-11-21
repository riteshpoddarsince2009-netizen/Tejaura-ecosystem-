# TEJAURA Development Roadmap

**Current Position:** Stage 3 — Core Control Plane, Persistent SQLite Orchestration & Phone-First Owner Control Plane UI Complete *(Automated-Test Verified; Physical GPU Inference, Mobile Device QA & Production Deployment Pending)*  
**Guiding Constraints:** Human-governed, open-source-first, local-model-first (AirLLM primary), model-provider agnostic, phone-first control plane, free-first, modular, and testable.

---

## Stage 0 — Foundational Repository & Governance *(Complete)*
**Status:** Implemented

- [x] Establish repository overview and honest status reporting (`README.md`)
- [x] Define constitutional governance principles and `L0`–`L4` autonomy levels (`core/constitution/TEJAURA_CONSTITUTION.md`)
- [x] Define system identity and mission (`core/identity/IDENTITY.md`)
- [x] Define least-privilege permission policy and `L4` approval gates (`core/permissions/PERMISSION_POLICY.md`)
- [x] Create validated initial system configuration (`core/configuration/system.json`)
- [x] Create versioned empty model registry and rules (`intelligence/model-registry/`)
- [x] Document modular architecture and staged roadmap (`docs/ARCHITECTURE.md`, `docs/ROADMAP.md`)
- [x] Configure secure `.gitignore` defaults

---

## Milestone 1 — Core Contracts & Validation Engine *(Complete)*
**Status:** Implemented & Tested

- [x] Define JSON Schema Draft 2020-12 contracts for `task`, `agent`, `tool`, `approval`, and `audit-event` (`contracts/schemas/`)
- [x] Define aligned strict TypeScript contract interfaces (`contracts/types/`)
- [x] Implement fail-closed Ajv Draft 2020-12 validation engine with `ajv-formats` (`contracts/validation/`)
- [x] Add automated contract and fail-closed validation tests (`contracts/tests/contracts.test.ts`)
- [x] Reconcile autonomy level definitions across `TEJAURA_CONSTITUTION.md`, `PERMISSION_POLICY.md`, and `system.json`
- [x] Document contracts, usage, safe extension, and versioning (`contracts/README.md`, `docs/CONTRACTS.md`)

---

## Stage 1 — Configuration Validation & Core Policy Engine *(Complete)*
**Status:** Implemented & Tested

- [x] Build JSON Schema Draft 2020-12 validators for `system.json` and `models.json` (`core/configuration/`, `intelligence/model-registry/`)
- [x] Implement deterministic Policy Evaluator (`L0`–`L4` enforcement, default-deny, fail-closed, closed action catalog) (`core/policy/`)
- [x] Implement non-self-approval gatekeeper state machine (`pending -> approved | rejected | expired`, single-use, environment-bound) (`core/approvals/`)
- [x] Add local append-only JSONL audit log writer with secret redaction, directory confinement, and DI storage (`core/audit/`)
- [x] Add automated security tests proving agents cannot self-approve, escalate permissions, or bypass audit failures (`core/tests/`)
- [x] Document security model, trust boundaries, and limitations (`docs/SECURITY_MODEL.md`, module READMEs)

---

## Stage 2 & 2A — AirLLM Primary Runtime & Local Model Infrastructure *(Complete — Mock-Verified)*
**Status:** Implemented & Tested Against Mock AirLLM Worker & Local Runtime Stubs *(Real GPU/Weight Inference Not Yet Executed)*

- [x] Implement strict Draft 2020-12 Local Model Registry (`intelligence/model-registry/local-model*`)
- [x] Integrate `AirLlmRuntimeAdapter` as TEJAURA's primary local inference runtime (`PRIMARY_LOCAL_RUNTIME = 'airllm'`) alongside secondary local adapters (`intelligence/runtime/`)
- [x] Implement isolated Python AirLLM worker service (`workers/airllm/`) with `X-TEJAURA-Worker-Token` verification and cooperative cancellation
- [x] Enforce trusted endpoint allowlists, paid third-party API host blocking, and `untrusted_model_output` tagging
- [x] Build Hardware Abstraction, Model Lifecycle Manager, and `ModelRouter` without paid API fallback (`intelligence/hardware/`, `intelligence/lifecycle/`, `intelligence/router/`)
- [ ] Hardware-in-the-loop verification of `RealAirLlmEngine` on owner GPU/NVMe hardware with a pre-staged open-weight checkpoint (manual owner test milestone)

---

## Stage 2B — Private Identity, Authentication & Security Foundation *(Complete)*
**Status:** Implemented & Tested

- [x] Independent owner identity (`setupInitialOwner`, username/email login, Argon2id hashing) (`core/auth/`, `core/security/`)
- [x] Secure `HttpOnly`, `Secure`, `SameSite`, `__Host-` session cookies, idle + absolute expiry, logout, session revocation, and rate limiting (`core/auth/`)
- [x] Extensible TOTP MFA & WebAuthn passkey modules (`core/auth/mfa-passkey.ts`) and single-use account recovery
- [x] Separate `SecretsManager` (`EnvSecretProvider` + AES-256-GCM vault) with strict `TEJAURA_AIRLLM_WORKER_TOKEN` separation (`core/secrets/`)
- [x] Default-deny RBAC (`owner`, `operator_readonly`, `agent_restricted`, `worker_service`) and typed audit emitters (`core/rbac/`, `core/audit/`)

---

## Stage 3 — Core Control Plane & Phone-First Owner Dashboard *(Complete — Automated-Test Verified)*
**Status:** Implemented & Tested Against Automated Suite *(Manual Android Browser QA & Live HTTPS Deployment Pending)*

- [x] Implement schema-migrated SQLite persistent orchestration store (`control-plane/db/`) for tasks, task events, execution attempts, leases, schedules, and approvals
- [x] Build priority-ordered `TaskOrchestrator` (`control-plane/orchestrator/`) with idempotency keys, deadlines, bounded retries, abortable cancellation, abandoned lease recovery, and non-idempotent external retry guards
- [x] Build authenticated Express control-plane API (`control-plane/server/`, `server.ts`) enforcing cookie auth, RBAC, CSRF headers/origin checks, `64KB` payload caps, production HTTPS checks, and metadata-only secret exposure
- [x] Build responsive mobile-first (`375px` Android-first + desktop sidebar) React control-plane UI (`src/`): Auth/Setup/Recovery, Overview Dashboard, Task Center, Approval Inbox (`L3`/`L4` required reason + 2-step confirmation), Schedules, Model & Runtime Center (`Probe Availability`), Read-Only System & Policy Inspector, Read-Only Audit Center, and Settings & Security
- [x] Add automated orchestration, HTTP API security, and React UI render/non-exposure tests (`control-plane/tests/`)
- [ ] Manual end-to-end QA on physical Android device over HTTPS reverse proxy and production hardening review

---

## Stage 4 — Sandboxed Local Execution & Modular Skills *(Planned)*
**Status:** Planned (Not Started)

- [ ] Implement bounded `L2` local task runner with strict path allowlists and execution timeouts
- [ ] Support modular capability plugins with manifest-declared permission scopes
- [ ] Implement pre-execution dry-run diffs for all file/workspace mutations

---

## Stage 5 — Supervised External Integrations & Release Readiness *(Planned)*
**Status:** Planned (Not Started)

- [ ] Support optional supervised (`L3`) external connectors behind explicit owner approval
- [ ] Enforce hard `L4` owner-exclusive checkpoints for any production deployment, payment/billing action, or public publishing
- [ ] Complete end-to-end security audit, threat-model review, and documentation verification
