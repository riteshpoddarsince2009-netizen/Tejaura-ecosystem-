# TEJAURA

> **Status:** Stage 2 — Core Governance, Policy Engine & Local Model Infrastructure Implemented (Pre-Alpha)  
> **Runtime Implementation:** Autonomous agents, sandboxed task execution, and the phone-first control-plane UI are **not yet implemented**. Implemented today: governance specifications, system/registry config validators, Core Contracts, deterministic Policy Evaluator (`L0`–`L4`), Approval Gatekeeper, append-only JSONL Audit Logger, and Stage 2 Local Model Infrastructure (Local Model Registry, Hardware Abstraction, direct Runtime Adapters for Ollama/llama.cpp/vLLM/SGLang/compatible servers, Lifecycle Manager, and Model Router).

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
- **Stage 1 Governance Engine (`core/`):**
  - `core/configuration/` — Draft 2020-12 system config validator (`validate-system-config.ts`).
  - `core/policy/` — Fail-closed `L0`–`L4` Policy Evaluator (`policy-evaluator.ts`).
  - `core/approvals/` — Non-self-approval gatekeeper (`approval-service.ts`).
  - `core/audit/` — Append-only JSONL Audit Logger with secret redaction (`audit-logger.ts`).
- **Stage 2 Local Model Infrastructure (`intelligence/`):**
  - `intelligence/model-registry/` — Local open-weight model registry (`local-model.schema.json`, `local-models.json`, `local-model-registry.ts`) plus Stage 1 `models.json` validator.
  - `intelligence/hardware/` — `HardwareManager` & `checkHardwareFit` for RAM, VRAM, storage, GPU, and runtime compatibility.
  - `intelligence/runtime/` — `RuntimeManager`, trusted endpoint guard, and direct adapters for Ollama, llama.cpp, vLLM, SGLang, and compatible local servers.
  - `intelligence/lifecycle/` — `ModelLifecycleManager` (availability, honest load/unload, priority queue, concurrency limits, circuit breaker & recovery).
  - `intelligence/router/` — `ModelRouter` (capability/hardware/context routing with zero paid API fallback).
  - `intelligence/tests/` — Mock HTTP server, hardware, lifecycle, routing, and security tests.
- **Technical Documentation:**
  - `docs/ARCHITECTURE.md` — Modular target architecture and component boundaries.
  - `docs/CONTRACTS.md` — Core Contracts specification, validation usage, extension guide, and versioning.
  - `docs/SECURITY_MODEL.md` — Stage 1 security architecture and trust boundaries.
  - `docs/LOCAL_MODELS.md` — Stage 2 local-model-first architecture, runtime matrix, and setup.
  - `docs/ROADMAP.md` — Staged development plan from foundation to operable OS.
- **Repository Hygiene:**
  - `.gitignore` — Secure defaults preventing accidental exposure of secrets, keys, and local artifacts.
  - Base web/Vite workspace scaffold (`package.json`, `index.html`, `src/`) preserved untouched until UI stages begin.

### Planned (Not Yet Implemented)
- Phone-first owner control plane UI (`L3`/`L4` approval inbox & status inspector)
- Sandboxed `L2` task execution runtime and modular skills
- Autonomous agent orchestration loops (bounded by owner governance)

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
- [Security Model](docs/SECURITY_MODEL.md)
- [Local Model Infrastructure](docs/LOCAL_MODELS.md)
- [Model Registry Rules](intelligence/model-registry/README.md)
- [System Architecture](docs/ARCHITECTURE.md)
- [Development Roadmap](docs/ROADMAP.md)
