# TEJAURA

> **Status:** Milestone 1 — Foundational Governance & Core Contracts Implemented (Pre-Alpha)  
> **Runtime Implementation:** Runtime orchestrators, agents, model adapters, databases, and control-plane UI are **not yet implemented**. This repository currently contains governance specifications, system configuration, model registry baseline, Core Contracts (JSON Schemas + TypeScript types + Ajv validator + tests), and architecture docs.

TEJAURA is a human-governed, modular AI operating system designed to be **open-source-first**, **model-provider agnostic**, **phone-first**, and **free-first**.

Unlike autonomous-by-default agent frameworks, TEJAURA places hard constitutional and policy boundaries around every capability: the human owner retains final authority, agents cannot grant themselves permissions or approve their own sensitive actions, and high-impact operations require explicit owner approval.

---

## Core Design Principles

1. **Human Owner Sovereignty:** The human owner retains full authority over system rules, permissions, resources, and execution.
2. **Non-Self-Approval & Least Privilege:** No agent or module may escalate its own permissions, alter governance rules unilaterally, or approve its own sensitive actions.
3. **Explicit Approval Gates:** Production deployments, financial payments, and public publishing always require explicit human owner approval.
4. **Zero Secrets in Source:** API keys, tokens, certificates, and credentials must never be committed to source code or configuration files.
5. **Open-Source-First & Provider-Agnostic:** Built around open standards and swappable provider adapters so no single model vendor or proprietary runtime is required.
6. **Phone-First & Free-First:** Designed from day one to be operable from mobile devices and runnable on free-tier or local resources without mandatory paid subscriptions.
7. **Modular & Testable:** Strict separation between governance (`core/`), model metadata (`intelligence/`), and future runtime/interface modules.

---

## Implemented vs. Planned Status

To avoid ambiguity, TEJAURA strictly separates what exists today from what is planned for future stages.

### Currently Implemented (This Repository)
- **Foundational Governance & Identity:**
  - `core/constitution/TEJAURA_CONSTITUTION.md` — Constitutional principles and autonomy levels (`L0`–`L4`).
  - `core/identity/IDENTITY.md` — System identity, mission, and non-goals.
  - `core/permissions/PERMISSION_POLICY.md` — Least-privilege model and mandatory human approval rules.
- **System Configuration:**
  - `core/configuration/system.json` — Validated initial JSON configuration baseline.
- **Model Registry Specification:**
  - `intelligence/model-registry/README.md` — Rules and schema for registering model providers.
  - `intelligence/model-registry/models.json` — Empty, versioned model registry baseline.
- **Core Contracts & Fail-Closed Validator (Milestone 1):**
  - `contracts/schemas/*.schema.json` — JSON Schema Draft 2020-12 contracts for `task`, `agent`, `tool`, `approval`, and `audit-event`.
  - `contracts/types/*.ts` — Strict TypeScript interfaces aligned with the JSON Schemas.
  - `contracts/validation/validator.ts` — Fail-closed Ajv Draft 2020-12 (`ajv` + `ajv-formats`) validation engine.
  - `contracts/tests/contracts.test.ts` — Automated contract and fail-closed validation test suite.
- **Technical Documentation:**
  - `docs/ARCHITECTURE.md` — Modular target architecture and component boundaries.
  - `docs/CONTRACTS.md` — Core Contracts specification, validation usage, extension guide, and versioning.
  - `docs/ROADMAP.md` — Staged development plan from foundation to operable OS.
- **Repository Hygiene:**
  - `.gitignore` — Secure defaults preventing accidental exposure of secrets, keys, and local artifacts.
  - Base web/Vite workspace scaffold (`package.json`, `index.html`, `src/`) preserved untouched until UI stages begin.

### Planned (Not Yet Implemented)
- Policy enforcement engine and runtime permission evaluator
- Human approval queue and mobile-first approval interface
- Model provider adapter layer (local & remote inference connectors)
- Task scheduler, sandboxed execution runtime, and persistent audit log store

---

## Repository Structure

```text
.
├── .env.example                                # Environment variable template (no real secrets)
├── .gitignore                                  # Secure ignore rules for secrets and build artifacts
├── README.md                                   # Project overview, current status, and setup
├── core/
│   ├── constitution/
│   │   └── TEJAURA_CONSTITUTION.md             # Governance principles and autonomy levels
│   ├── identity/
│   │   └── IDENTITY.md                         # TEJAURA identity, mission, and values
│   ├── permissions/
│   │   └── PERMISSION_POLICY.md                # Least-privilege rules and approval gates
│   └── configuration/
│       └── system.json                         # Initial validated system configuration
├── contracts/
│   ├── README.md                               # Core Contracts overview and usage
│   ├── schemas/                                # JSON Schema Draft 2020-12 contracts
│   ├── types/                                  # Strict TypeScript contract types
│   ├── validation/                             # Fail-closed Ajv validation engine
│   └── tests/                                  # Automated contract test suite
├── intelligence/
│   └── model-registry/
│       ├── README.md                           # Model registry rules and schema contract
│       └── models.json                         # Empty versioned model registry
└── docs/
    ├── ARCHITECTURE.md                         # Modular architecture specification
    ├── CONTRACTS.md                            # Contracts reference and extension guide
    └── ROADMAP.md                              # Staged implementation roadmap
```

*(Note: Existing web workspace files such as `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, and `src/` remain untouched as the host workspace shell for future UI stages.)*

---

## Setup & Validation

At this stage, setup consists of cloning the repository, configuring local environment variables safely if needed later, and verifying configuration integrity.

### Prerequisites
- Git
- Node.js 20+ and npm (for workspace tooling and future TypeScript validation/build steps)

### Quick Start
1. **Verify no secrets are tracked:**
   Ensure any future local credentials live in `.env` (which is ignored by `.gitignore`) and never in tracked files.
   ```bash
   cp .env.example .env
   ```
2. **Run contract tests, type checks, and build verification:**
   ```bash
   npm install
   npm test
   npm run lint
   npm run build
   ```
3. **Validate JSON configuration and contract schema files:**
   ```bash
   node -e "for (const f of ['core/configuration/system.json', 'intelligence/model-registry/models.json', 'contracts/schemas/task.schema.json', 'contracts/schemas/agent.schema.json', 'contracts/schemas/tool.schema.json', 'contracts/schemas/approval.schema.json', 'contracts/schemas/audit-event.schema.json']) { JSON.parse(require('fs').readFileSync(f, 'utf8')); } console.log('All JSON valid');"
   ```
4. **Read the governance documents before contributing:**
   Review `core/constitution/TEJAURA_CONSTITUTION.md`, `core/permissions/PERMISSION_POLICY.md`, `docs/CONTRACTS.md`, and `docs/ROADMAP.md` before proposing runtime modules.

---

## Documentation Index

- [TEJAURA Constitution](core/constitution/TEJAURA_CONSTITUTION.md)
- [TEJAURA Identity](core/identity/IDENTITY.md)
- [Permission Policy](core/permissions/PERMISSION_POLICY.md)
- [System Configuration](core/configuration/system.json)
- [Core Contracts Guide](docs/CONTRACTS.md)
- [Model Registry Rules](intelligence/model-registry/README.md)
- [System Architecture](docs/ARCHITECTURE.md)
- [Development Roadmap](docs/ROADMAP.md)
