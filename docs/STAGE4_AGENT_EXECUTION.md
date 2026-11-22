# TEJAURA Stage 4 — Sandboxed Agent Execution Foundation

**Status:** Foundation Implemented & Mock-Verified (Pre-Alpha)

This document defines the Stage 4 controlled execution foundation under `execution/` and its integration with `control-plane/db/` and `control-plane/server/`.

---

## 1. Architecture Overview

Stage 4 provides the governed execution pipeline that sits **behind** Stage 1 Policy Evaluation, Stage 2B Owner Auth/RBAC/Secrets, and Stage 3 Approval Inbox & SQLite Persistence:

1. **`AgentExecutionEngine` (`execution/agent-execution-engine.ts`)**
   - Validates every execution request fail-closed (`validateSandboxExecution`).
   - Integrates with `ApprovalService` so consequential actions (`L3` supervised actions, `L4` owner-sensitive operations, network/browser egress, or elevated-risk tools) pause for human owner approval and consume single-use approvals atomically.
   - Persists jobs (`queued -> running -> completed | failed | cancelled`) and structured redacted logs into SQLite (`agent_execution_jobs`, `agent_execution_logs` via migration `002_stage4_agent_execution`).
   - Enforces timeouts (`AbortController`), owner-only cancellation, bounded retries (`max_retries`), idempotency deduplication, and crash/restart recovery (`recoverOnStartup()`).

2. **Default-Deny Sandbox Policy (`execution/sandbox-policy.ts`)**
   - Validates `Agent` (`L4` banned, `active` + `enabled`) and `Tool` (`enabled`, allowlisted in `agent.allowed_tool_ids`, matching scope in `declared_scopes`) against Stage 1 contracts.
   - Enforces workspace path allowlisting and containment (`path.resolve` + trailing separator + `realpathSync` symlink checks), explicitly rejecting `..` traversal, absolute paths, `.env*`, `.tejaura-state`, `.ssh`, `system.json`, and constitution/policy documents.
   - Blocks arbitrary shell execution (`requested_shell_command`, shell tools/scopes).
   - Blocks `unrestricted` network and browser access, enforces explicit allowlists without wildcards, and blocks paid third-party AI API hosts.
   - Blocks agents from modifying permissions, policies, RBAC, secrets, or approving their own requests.

3. **Sandbox Adapter Interface & `MockSandboxAdapter` (`execution/mock-sandbox-adapter.ts`)**
   - Clean `SandboxAdapter` boundary (`providerId`, `isolationLevel`, `supportsOsIsolation`, `isolationDisclaimer`, `execute(context, signal)`).
   - `MockSandboxAdapter` (`providerId: 'mock_sandbox_v1'`, `isolationLevel: 'mock_in_process'`, `supportsOsIsolation: false`) simulates bounded execution across planned agent departments (`research`, `engineering`, `seo`, `design`, `content`, `analytics`, `customer_support`) and optionally routes local model checks via `ModelRouter` (AirLLM primary, zero paid API fallback).

4. **Secret Redaction (`execution/secret-redactor.ts`)**
   - Scrubs secret keys (`password`, `api_key`, `token`, `private_key`, `master_key`, etc.), inline credential patterns (`Bearer ...`, `sk-...`, `AIza...`, `ghp_...`, PEM private keys), and runtime secret values (`TEJAURA_SECRETS_MASTER_KEY`, `TEJAURA_AIRLLM_WORKER_TOKEN`) from persisted job inputs, outputs, errors, and execution logs.

---

## 2. Explicit Security & Isolation Boundaries

- **Mock Sandbox Does NOT Provide OS-Level Isolation:** `MockSandboxAdapter` executes in-process simulations for development and automated testing only. It does **not** create Linux namespaces, cgroups, seccomp filters, chroot jails, or container boundaries (`supportsOsIsolation === false`).
- **No Shell Execution in Control Plane:** Neither `AgentExecutionEngine` nor `MockSandboxAdapter` spawns shell commands inside the Node.js control plane server.
- **Zero Paid Third-Party AI Fallback:** Local inference checks route strictly through TEJAURA's controlled `ModelRouter` (AirLLM primary).

---

## 3. Remaining Stage 4 Work

- Implement an `isolated_container` `SandboxAdapter` backed by rootless containers / microVMs with OS-level filesystem, PID, CPU/memory, and network namespace isolation.
- Implement concrete department agent workflows (`research`, `engineering`, `seo`, `design`, `content`, `analytics`, `customer_support`) using versioned `Agent` and `Tool` manifests.
- Expose dedicated execution job & log views in the mobile-first Control Plane UI (`src/`) once concrete agents are enabled.
