# TEJAURA Modular System Architecture

**Document Version:** 1.0.0  
**Implementation Status:** Architecture Specification (Stage 0). Only `core/`, `intelligence/model-registry/` specifications, and `docs/` exist today. Runtime execution layers are **planned**.

---

## 1. Architectural Philosophy

TEJAURA is structured as a layered, modular operating system where **governance sits above intelligence**, and **execution sits behind explicit policy gates**:

- **Governance First:** No execution layer can operate without consulting `core/` policies and configuration.
- **Strict Module Boundaries:** Components communicate through typed contracts and well-defined schemas rather than shared global state.
- **Provider Agnosticism:** Model providers and external tools live behind interchangeable adapter interfaces.
- **Phone-First Control Plane:** All user-facing workflows, approval prompts, and system diagnostics are designed to be legible and actionable on small mobile viewports first.
- **Testability by Default:** Each module must be independently unit-testable without requiring live external LLM calls or paid infrastructure.

---

## 2. System Layer Overview

```text
+-------------------------------------------------------------------+
|                   4. INTERFACES (Planned)                         |
|   Phone-First Control UI  |  Approval Inbox  |  Local CLI         |
+-------------------------------------------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|                 1. CORE GOVERNANCE (Implemented Spec)             |
|   Constitution  |  Identity  |  Permission Policy  |  system.json |
+-------------------------------------------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|               2. RUNTIME & POLICY ENGINE (Planned)                |
|   Policy Evaluator  |  Approval Gatekeeper  |  Audit Logger       |
|   Task Orchestrator |  Sandboxed Executor                         |
+-------------------------------------------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|         3. INTELLIGENCE & ADAPTERS (Registry Spec Only)           |
|   Model Registry (models.json)  |  Provider-Agnostic Adapters     |
|   Local / Open-Source Runtimes  |  Optional External Connectors   |
+-------------------------------------------------------------------+
```

---

## 3. Module Responsibilities

### 3.1 `core/` *(Implemented as Specification & Initial Config)*
- **`core/constitution/TEJAURA_CONSTITUTION.md`:** Defines supreme governance rules and autonomy levels (`L0`–`L4`).
- **`core/identity/IDENTITY.md`:** Defines TEJAURA's mission, principles, and boundaries.
- **`core/permissions/PERMISSION_POLICY.md`:** Defines least-privilege scopes, fail-closed semantics, and mandatory `L4` owner approval gates.
- **`core/configuration/system.json`:** Machine-readable baseline enforcing `defaultAutonomyLevel: "L1"`, `maxAutonomousLevel: "L2"`, and mandatory approval flags.

### 3.2 `intelligence/` *(Registry Specification Implemented; Adapters Planned)*
- **`intelligence/model-registry/models.json`:** Versioned catalog of approved model providers (currently empty).
- **`intelligence/model-registry/README.md`:** Rules ensuring zero secrets, open-source-first defaults, and uniform adapter metadata.
- **Planned Model Router & Adapters:** Thin translation layer normalizing chat/completion/tool calls across local runtimes (e.g., Ollama, llama.cpp) and optional remote APIs.

### 3.3 `runtime/` *(Planned — Not Yet Implemented)*
- **Policy Evaluator:** Validates every requested action against `PERMISSION_POLICY.md` and `system.json` before execution.
- **Approval Gatekeeper:** Intercepts `L3`/`L4` actions, freezes execution, emits an approval request to the human owner, and verifies out-of-band owner confirmation (preventing self-approval).
- **Sandboxed Executor:** Runs approved `L2` local tasks within strict filesystem, timeout, and memory limits.
- **Append-Only Audit Logger:** Records proposals, policy decisions, approvals, and execution outcomes locally.

### 3.4 `interfaces/` *(Planned — Not Yet Implemented)*
- **Phone-First Web Control Plane:** Responsive mobile UI for inspecting system state, reviewing `L1` drafts, and approving or denying `L3`/`L4` requests with one-tap clarity.
- **CLI / Local Diagnostics:** Lightweight developer and operator commands for validating configs and running offline tests.

---

## 4. Data & Control Flow for Any Action (Target Design)

1. **Intent Received:** Owner submits a task via a phone-first interface or CLI.
2. **Planning (`L1`):** Intelligence layer proposes a structured plan using only registered models from `models.json`.
3. **Policy Check:** Runtime Policy Evaluator inspects each step's required scopes and autonomy level (`L0`–`L4`).
4. **Gate Enforcement:**
   - `L0`–`L1`: Safe to inspect/display to owner.
   - `L2`: Permitted inside sandbox if explicitly covered by policy; logged.
   - `L3`: Pauses for explicit owner approval.
   - `L4` (Deployments, Payments, Public Publishing, Policy/Secret Changes): Hard-locked; pauses and requires explicit human owner approval and execution confirmation.
5. **Execution & Audit:** Only approved actions execute, with results and policy verdicts recorded transparently.

---

## 5. Non-Negotiable Security Boundaries

- **No Secret Leakage:** Config files and source files hold zero secrets; runtime reads credentials strictly from environment variables or local OS keychains.
- **No Unchecked Escalation:** Runtime processes run without write access to `core/constitution/` or `core/permissions/`.
- **Offline-Capable Baseline:** Core governance checks, configuration validation, and local model routing must function without mandatory external cloud dependencies.
