# TEJAURA

> **Status:** Stage 4.6 — Real Isolated Execution, Department Agents & Multi-Agent Orchestration Implemented (Pre-Alpha)
> **Implementation Scope:** Implemented today: governance specifications, system/registry config validators, Core Contracts (`contracts/`), deterministic Policy Evaluator (`L0`–`L4`), Approval Gatekeeper, append-only JSONL Audit Logger, Stage 2/2A AirLLM-primary Local Model Infrastructure (`intelligence/`, `workers/airllm/`), Stage 2B Private Identity/Auth/RBAC/Secrets Foundation (`core/`), Stage 3 SQLite Task Orchestrator + Express Control Plane API + Mobile-First React UI (`control-plane/`, `server.ts`, `src/`), Stage 4 Sandboxed Agent Execution Foundation (`execution/`, SQLite v2 execution jobs & logs, `MockSandboxAdapter`), Stage 4.5 Owner Management Center with transport-safe auth, approval-gated runtime/project mutations, persistent agent/model/worker/project administration, backups, and audit inspection, and Stage 4.6 Real Isolated Execution with Docker container sandboxing, ten department agents (including bounded research synthesis), owner-gated multi-agent delegation, AirLLM worker integration, and an AI Workforce UI. Physical GPU verification and Stage 5 external integrations remain **pending**.

TEJAURA is a human-governed, modular AI operating system designed to be **open-source-first**, **model-provider agnostic**, **phone-first**, and **free-first**.

Unlike autonomous-by-default agent frameworks, TEJAURA places hard constitutional and policy boundaries around every capability: the human owner retains final authority, agents cannot grant themselves permissions or approve their own sensitive actions, and high-impact operations require explicit owner approval.

---

## Core Design Principles

1. **Human Owner Sovereignty:** The human owner retains full authority over system rules, permissions, resources, and execution.
2. **Non-Self-Approval & Least Privilege:** No agent or module may escalate its own permissions, alter governance rules unilaterally, or approve its own sensitive actions.
3. **Explicit Approval Gates:** Production deployments, financial payments, and public publishing always require explicit human owner approval.
4. **Zero Secrets in Source:** API keys, tokens, certificates, and credentials must never be committed to source code or configuration files.
5. **Open-Source-First & Provider-Agnostic:** Built around open standards and swappable local runtime adapters (`airllm` primary; Ollama, llama.cpp, vLLM, SGLang secondary) with **zero paid third-party AI API fallback**.
6. **Phone-First & Free-First:** The phone/mobile browser acts as the owner's control device while open-weight inference runs on owner-controlled compute nodes.
7. **Modular & Testable:** Strict separation between governance (`core/`), local intelligence (`intelligence/`), persistent orchestration/control server (`control-plane/`, `server.ts`), and control-plane UI (`src/`).

---

## Implemented vs. Planned Status

To avoid ambiguity, TEJAURA strictly separates automated-test-verified capabilities from planned modules and unverified hardware environments.

### Currently Implemented (Automated-Test Verified)
- **Foundational Governance & Contracts (`core/`, `contracts/`):**
  - `core/constitution/TEJAURA_CONSTITUTION.md`, `core/identity/IDENTITY.md`, `core/permissions/PERMISSION_POLICY.md`, `core/configuration/system.json`
  - JSON Schema Draft 2020-12 contracts & fail-closed Ajv validators (`contracts/schemas/`, `contracts/types/`, `contracts/validation/`)
- **Stage 1 Policy, Approval & Audit Engine (`core/`):**
  - Fail-closed `L0`–`L4` Policy Evaluator with closed action catalog (`core/policy/`)
  - Non-self-approval gatekeeper (`core/approvals/`)
  - Append-only JSONL Audit Logger with secret redaction and directory confinement (`core/audit/`)
- **Stage 2 & 2A AirLLM-Primary Local Model Infrastructure (`intelligence/`, `workers/airllm/`):**
  - Strict Draft 2020-12 Local Model Registry (`local-models.json`), `HardwareManager`, `RuntimeManager`, `AirLlmRuntimeAdapter` (`PRIMARY_LOCAL_RUNTIME = 'airllm'`), `ModelLifecycleManager`, `ModelRouter`, and authenticated Python AirLLM worker protocol (`workers/airllm/`).
  - *Note:* Tested against offline HTTP mocks (`MockAirLlmEngine`); physical GPU/NVMe weight inference with `RealAirLlmEngine` has not been hardware-verified here.
- **Stage 2B Private Identity, Auth, RBAC & Secrets Foundation (`core/`):**
  - Independent initial owner setup, Argon2id password hashing, `HttpOnly`/`Secure`/`SameSite` cookies, idle + absolute expiry, logout, session revocation, login rate limiting, extensible TOTP MFA + WebAuthn passkeys, single-use recovery codes, default-deny RBAC (`core/rbac/`), and AES-256-GCM encrypted `SecretsManager` (`core/secrets/`).
- **Stage 3 Persistent Orchestration, Control Plane API & Phone-First UI (`control-plane/`, `server.ts`, `src/`):**
  - **Persistent SQLite State (`control-plane/db/`):** Schema-migrated SQLite store (`node:sqlite`, WAL mode) persisting tasks, task events, execution attempts, worker leases, schedules, and approvals across restarts.
  - **Governed Orchestrator (`control-plane/orchestrator/`):** Priority queues, idempotency keys, deadlines, bounded retries, abortable execution, lease recovery, and blocking automatic retries on non-idempotent external actions.
  - **Authenticated HTTP API (`control-plane/server/`, `server.ts`):** Cookie sessions, CSRF (`X-TEJAURA-CSRF: 1` + Origin/Referer checks), sliding-window API rate limits, `64KB` JSON payload caps, production HTTPS enforcement, and read-only secret presence metadata (never secret values).
  - **Mobile-First Owner Control Plane UI (`src/`):** Initial setup & one-time recovery codes, login (+ MFA) & recovery, Overview Dashboard, Task Center (create/inspect/cancel/confirm-retry), Approval Inbox (required reason + 2-step confirmation), Schedules, Model & Runtime Center (live availability probe), Read-Only System & Policy Inspector, Read-Only Audit Center, and Settings & Security.

- **Stage 4 Sandboxed Agent Execution Foundation (`execution/`, `control-plane/db/`, `control-plane/server/`):**
  - **Execution Engine & Persistence:** Converts approved agent tasks into persistent SQLite execution jobs (`queued`, `running`, `completed`, `failed`, `cancelled`) and structured secret-redacted logs (`002_stage4_agent_execution`), with timeouts, owner-only cancellation, bounded retries, idempotency keys, and restart recovery.
  - **Default-Deny Sandbox Policy & Mock Adapter:** `Agent`/`Tool` contract validation, workspace path allowlists, shell blocking, unrestricted network/browser denial, `ApprovalService` gating, and `MockSandboxAdapter` (`supportsOsIsolation: false` — dev/test simulation only).

- **Stage 4.6 Real Isolated Execution, Department Agents & Multi-Agent Orchestration (`agents/`, `execution/`, `control-plane/`, `src/`):**
  - **Real Container Isolation:** `ContainerSandboxAdapter` + a fixed Node runner execute engineering tasks in Docker with a non-root UID, read-only root filesystem, all capabilities dropped, `no-new-privileges`, `--network=none`, PID/memory/CPU limits, path-confined writes, a closed test-command allowlist, structured test evidence, and secret redaction. Docker absence fails closed; production rejects the mock provider.
  - **Ten Department Agents:** CEO Strategy, Engineering, Design, SEO, Content & Social, Analytics, Security, QA, Customer Support, and Research, each with distinct capabilities, closed actions, scoped tools, JSON schemas, autonomy ceilings, retry/depth limits, and explicit delegate allowlists.
  - **Owner-Gated Delegation:** A persistent delegation DAG with idempotency, dependencies, bounded retries, depth/child limits, owner cancellation, startup recovery, watchdog alerts, and CEO consolidation. Self-delegation, unknown actions, and privilege-field injection are rejected.
  - **Approval & Audit Reuse:** Sensitive delegation tasks create real `ApprovalService` records; only the designated owner can decide them; decisions and every task transition are audited. Content approval authorizes a manual release package and never auto-publishes.
  - **AirLLM Worker Integration:** `AirLlmModelWorker` uses the existing authenticated `RuntimeManager` AirLLM contract, marks output untrusted, redacts secrets, persists worker heartbeats, and creates unhealthy-worker alerts. Deterministic CEO planning works without a model worker; no paid API fallback exists.
  - **Owner API & UI:** `/api/stage46/*` routes and a mobile-first “AI Workforce” tab expose agents, objectives, pipeline status, approval links, sandbox isolation status, worker health, alerts, and task event timelines.

- **Stage 4.5 Owner Management Center, Authentication Repair & Security Audit (`control-plane/management/`, `src/`, `core/secrets/`):**
  - **Transport-Safe Auth:** `https_direct`, `https_embedded_iframe` (CHIPS partitioned cookies), and strictly loopback-only `http_loopback_dev` session modes; multi-hop proxy-aware CSRF origin checks; post-login cookie verification; TOTP whitespace normalization.
  - **Owner Management Modules:** Persistent SQLite v3 records for agents, models, workers, projects, system config, and backups, exposed through owner-authenticated management APIs and a mobile-first management UI.
  - **Approval-Gated Runtime & Deployment Actions:** Worker registration/toggle/delete and staging/production project deploys create real `ApprovalService` requests and execute only after a separate owner decision. Client-supplied L4 confirmation flags are ignored; L4 tasks always enter the Approval Inbox.
  - **Security Repairs:** Removed fabricated owner auto-approval paths, added startup-only rehydration for persisted models/endpoints without minting approvals, and made encrypted vault writes atomic with strict entry validation.

### Planned / Not Yet Hardware- or Deployment-Verified
- **Remaining Stage 4:** physical GPU/NVMe AirLLM verification, dry-run diffs, and deeper execution-job inspection UI tabs. OS-level `isolated_container` sandboxing and concrete department agents are now implemented in Stage 4.6.
- **Stage 5:** Supervised `L3` external integrations, end-to-end penetration/security audit, and physical GPU/Android device deployment verification.

---

## Running & Initial Setup

### Prerequisites
- Node.js 22+ (uses built-in `node:sqlite`) and npm
- Python 3.10+ (optional, for `workers/airllm/test_worker.py` or running the local AirLLM worker)

### Quick Start
1. **Configure environment safely:**
   Never commit `.env` or secret material. In production mode, set a strong `TEJAURA_SECRETS_MASTER_KEY` (and `TEJAURA_AIRLLM_WORKER_TOKEN` / `TEJAURA_AIRLLM_WORKER_URL` if attaching an external AirLLM worker):
   ```bash
   cp .env.example .env
   ```
2. **Install dependencies and run full automated verification:**
   ```bash
   npm install
   npm test
   npm run lint
   npm run build
   python3 workers/airllm/test_worker.py
   ```
3. **Start the full-stack control plane server (port 3000):**
   ```bash
   npm run dev
   ```
   Open `http://127.0.0.1:3000` (or from an Android phone on a trusted HTTPS/LAN tunnel) and complete **Initial Owner Account Setup** once, saving the single-use recovery codes offline.

---

## Documentation Index

- [TEJAURA Constitution](core/constitution/TEJAURA_CONSTITUTION.md)
- [TEJAURA Identity](core/identity/IDENTITY.md)
- [Permission Policy](core/permissions/PERMISSION_POLICY.md)
- [System Configuration](core/configuration/system.json)
- [Core Contracts Guide](docs/CONTRACTS.md)
- [Security Model](docs/SECURITY_MODEL.md)
- [Auth & Secrets Architecture](docs/AUTH_AND_SECRETS.md)
- [Stage 2B Threat Model](docs/THREAT_MODEL.md)
- [Local Model Infrastructure](docs/LOCAL_MODELS.md)
- [Stage 3 Control Plane Guide](docs/CONTROL_PLANE_STAGE3.md)
- [Stage 4 Agent Execution Foundation](docs/STAGE4_AGENT_EXECUTION.md)
- [Stage 4.6 Real Isolated Execution & Multi-Agent Orchestration](docs/STAGE4_6_MULTI_AGENT.md)
- [System Architecture](docs/ARCHITECTURE.md)
- [Development Roadmap](docs/ROADMAP.md)
