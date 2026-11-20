# TEJAURA Development Roadmap

**Current Position:** Stage 0 — Foundation Complete (Documentation, Governance & Configuration Baseline)  
**Guiding Constraints:** Human-governed, open-source-first, model-provider agnostic, phone-first, free-first, modular, and testable.

---

## Stage 0 — Foundational Repository & Governance *(Current)*
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

## Stage 1 — Configuration Validation & Core Policy Engine *(Planned)*
**Status:** Planned (Not Started)

- [ ] Build schema validators (TypeScript) for `system.json` and `models.json`
- [ ] Implement deterministic Policy Evaluator (`L0`–`L4` enforcement, default-deny, fail-closed)
- [ ] Implement non-self-approval gatekeeper state machine (pending -> approved/rejected -> expired)
- [ ] Add local append-only audit log writer (free, file-based JSONL/SQLite)
- [ ] Add comprehensive unit tests proving agents cannot self-approve or escalate permissions

---

## Stage 2 — Provider-Agnostic Intelligence Layer *(Planned)*
**Status:** Planned (Not Started)

- [ ] Define unified TypeScript `ModelAdapter` interface (provider-agnostic)
- [ ] Implement free-first / local open-source adapter (e.g., Ollama / OpenAI-compatible local server)
- [ ] Add safe environment-variable credential resolver (never reading/exposing secrets in prompts or configs)
- [ ] Build model registry loader enforcing `enabled: true` and `costTier` guards
- [ ] Add mock-adapter integration tests for offline CI verification

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
