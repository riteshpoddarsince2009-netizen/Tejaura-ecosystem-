# TEJAURA Development Roadmap

**Current Position:** Stage 2 — Local Model Infrastructure & Direct Model Connection Complete  
**Guiding Constraints:** Human-governed, open-source-first, local-model-first, model-provider agnostic, phone-first, free-first, modular, and testable.

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

## Stage 2 — Local Model Infrastructure & Direct Model Connection *(Current)*
**Status:** Implemented & Tested

- [x] Implement strict Draft 2020-12 Local Model Registry (`local_first_only: true`, `allow_paid_third_party_apis: false`, zero secrets, L4 owner-gated mutations) (`intelligence/model-registry/local-model*`)
- [x] Implement provider-independent `RuntimeAdapter` & `RuntimeManager` for Ollama, llama.cpp, vLLM, SGLang, and OpenAI-compatible self-hosted servers (`intelligence/runtime/`)
- [x] Enforce trusted endpoint allowlists, redirect denial, paid third-party API host blocking, timeouts, `AbortSignal` cancellation, and `untrusted_model_output` tagging (`intelligence/runtime/endpoint-guard.ts`)
- [x] Build Hardware Abstraction (`ComputeNode`, `HardwareManager`, fail-closed `checkHardwareFit` for RAM, VRAM, storage, GPU, and runtime support) (`intelligence/hardware/`)
- [x] Build Model Lifecycle Manager with availability checks, honest load/unload support reporting, bounded priority queue, concurrency limits, circuit breaker, and health-probe recovery (`intelligence/lifecycle/`)
- [x] Build capability- and hardware-aware `ModelRouter` with zero paid third-party API fallback (`intelligence/router/`)
- [x] Integrate `PolicyEvaluator`, `ApprovalService`, and `AuditLogger` for `runtime:manage`, `model:download`, `model:load`/`unload`, `model:discover`, `model:invoke_local`, and `model:registry_write`
- [x] Add mock HTTP server & security tests (`intelligence/tests/`) and Stage 2 architecture documentation (`docs/LOCAL_MODELS.md`)

---

## Stage 3 — Phone-First Owner Control Plane *(Planned)*
**Status:** Planned (Not Started)

- [ ] Design and build responsive mobile-first web UI (375px-first viewport ergonomics)
- [ ] Implement Owner Approval Inbox for `L3` and `L4` actions (clear impact summaries, approve/reject controls)
- [ ] Implement System Status & Policy Inspector (read-only view of active autonomy limits, registry entries, and audit trail)
- [ ] Add draft proposal (`L1`) review workflow before applying local changes

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
